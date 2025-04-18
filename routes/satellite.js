const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { pipeline } = require('stream/promises');
const { PLANET_API_KEY, PLANET_API_URL } = require('../config/planet');
const logger = require('../config/logger');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db');

const router = express.Router();

router.post('/fetch-image', async (req, res) => {
  const { shapefileId } = req.body;
  const transactionId = uuidv4();
  logger.info(`[${transactionId}] Fetching satellite images for shapefile: ${shapefileId}`);

  try {
    // Validate input
    if (!shapefileId) {
      logger.warn(`[${transactionId}] Missing shapefileId`);
      return res.status(400).json({ error: 'Missing shapefileId' });
    }

    // Lấy bbox từ database
    const result = await pool.query(
      'SELECT ST_AsGeoJSON(bbox) AS bbox FROM shapefiles WHERE id = $1',
      [shapefileId]
    );
    if (!result.rows[0]) {
      logger.warn(`[${transactionId}] Shapefile not found: ${shapefileId}`);
      return res.status(404).json({ error: 'Shapefile not found' });
    }

    const bboxGeoJSON = JSON.parse(result.rows[0].bbox);
    if (!bboxGeoJSON.coordinates || !bboxGeoJSON.coordinates[0]) {
      logger.warn(`[${transactionId}] Invalid bbox for shapefile: ${shapefileId}`);
      return res.status(400).json({ error: 'Invalid bounding box in shapefile' });
    }

    const bbox = bboxGeoJSON.coordinates[0];
    const geometryFilter = {
      type: 'Polygon',
      coordinates: [bbox]
    };

    // Gửi yêu cầu tới Planet API
    const response = await axios.post(
      `${PLANET_API_URL}/quick-search`,
      {
        item_types: ['PSScene'],
        filter: {
          type: 'AndFilter',
          config: [
            { type: 'GeometryFilter', field_name: 'geometry', config: geometryFilter },
            { type: 'RangeFilter', field_name: 'cloud_cover', config: { lte: 0.1 } },
            {
              type: 'DateRangeFilter',
              field_name: 'acquired',
              config: { gte: '2023-01-01T00:00:00Z' } // Sửa định dạng date-time
            },
            { type: 'StringInFilter', field_name: 'quality_category', config: ['standard'] }
          ]
        }
      },
      {
        headers: { Authorization: `api-key ${PLANET_API_KEY}` },
        validateStatus: status => status < 500 // Chấp nhận mọi status < 500
      }
    );

    // Xử lý lỗi từ Planet API
    if (response.status !== 200) {
      logger.error(`[${transactionId}] Planet API error`, {
        status: response.status,
        data: response.data
      });
      return res.status(response.status).json({
        error: 'Failed to fetch images from Planet API',
        details: response.data
      });
    }

    logger.info(`[${transactionId}] Fetched ${response.data.features.length} images`);
    res.json(response.data.features);
  } catch (error) {
    logger.error(`[${transactionId}] Failed to fetch images`, {
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: 'Failed to fetch images', details: error.message });
  }
});

router.post('/process-image', async (req, res) => {
  const { imageUrl, type, shapefileId, format = 'png' } = req.body;
  const transactionId = uuidv4();
  logger.info(`[${transactionId}] Processing image`, { type, shapefileId });

  if (!imageUrl || !type || !shapefileId) {
    logger.warn(`[${transactionId}] Missing parameters`);
    return res.status(400).json({ error: 'Missing imageUrl, type, or shapefileId' });
  }

  const VALID_TYPES = ['ndvi', 'ndbi', 'ndwi'];
  if (!VALID_TYPES.includes(type.toLowerCase())) {
    logger.warn(`[${transactionId}] Invalid type: ${type}`);
    return res.status(400).json({ error: `Type must be one of ${VALID_TYPES.join(', ')}` });
  }

  const imagePath = path.join(__dirname, '../data', `temp_${transactionId}.tif`);
  const shpGeoJsonPath = path.join(__dirname, '../data', `shp_${transactionId}.json`);
  let geotiffPath, previewPath;

  try {
    // Lấy geometry từ shapefile
    const shpResult = await pool.query(
      'SELECT ST_AsGeoJSON(geom) AS geometry FROM shapefiles WHERE id = $1',
      [shapefileId]
    );
    if (!shpResult.rows[0]) {
      logger.warn(`[${transactionId}] Shapefile not found: ${shapefileId}`);
      return res.status(404).json({ error: 'Shapefile not found' });
    }
    fs.writeFileSync(shpGeoJsonPath, shpResult.rows[0].geometry);

    // Kiểm tra kích thước ảnh
    const headResponse = await axios.head(imageUrl);
    const contentLength = parseInt(headResponse.headers['content-length']);
    if (contentLength > 100 * 1024 * 1024) {
      logger.warn(`[${transactionId}] Image too large: ${contentLength} bytes`);
      return res.status(400).json({ error: 'Image too large (max 100MB)' });
    }

    // Tải ảnh
    const response = await axios.get(imageUrl, { responseType: 'stream', timeout: 60000 });
    await pipeline(response.data, fs.createWriteStream(imagePath));
    logger.info(`[${transactionId}] Image downloaded`, { imagePath });

    // Xử lý ảnh với Python
    const scriptPath = path.join(__dirname, '../process_satellite.py');
    const output = await new Promise((resolve, reject) => {
      exec(
        `python3 ${scriptPath} ${imagePath} ${type} ${shpGeoJsonPath}`,
        { timeout: 300000 },
        (error, stdout) => {
          if (error) {
            logger.error(`[${transactionId}] Python error`, { error: error.message });
            return reject(error);
          }
          const geotiffMatch = stdout.match(/geotiff:(.+)/);
          const previewMatch = stdout.match(/preview:(.+)/);
          if (!geotiffMatch?.[1] || !previewMatch?.[1]) {
            return reject(new Error('Invalid output paths'));
          }
          resolve({
            geotiff: geotiffMatch[1].trim(),
            preview: previewMatch[1].trim()
          });
        }
      );
    });

    geotiffPath = output.geotiff;
    previewPath = output.preview;

    // Lưu preview URL vào metadata
    await pool.query(
      'UPDATE shapefiles SET metadata = metadata || $1 WHERE id = $2',
      [{ previewUrl: `/data/${path.basename(previewPath)}` }, shapefileId]
    );

    // Trả về file theo format
    const filePath = format === 'geotiff' ? geotiffPath : previewPath;
    res.download(filePath, `result_${type}.${format}`);
  } catch (error) {
    logger.error(`[${transactionId}] Processing failed`, { error: error.message });
    res.status(500).json({ error: 'Image processing failed' });
  } finally {
    [imagePath, shpGeoJsonPath, geotiffPath, previewPath].filter(Boolean).forEach(file => {
      try { fs.unlinkSync(file); } catch (e) {
        logger.warn(`[${transactionId}] Cleanup failed: ${file}`, { error: e.message });
      }
    });
  }
});

router.get('/preview/:shapefileId', async (req, res) => {
  try {
    const { shapefileId } = req.params;
    const result = await pool.query(
      'SELECT metadata->>\'previewUrl\' AS preview_url FROM shapefiles WHERE id = $1',
      [shapefileId]
    );
    if (!result.rows[0]?.preview_url) {
      return res.status(404).json({ error: 'Preview not found' });
    }
    res.json({ previewUrl: result.rows[0].preview_url });
  } catch (error) {
    logger.error('Failed to fetch preview', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch preview' });
  }
});

module.exports = router;