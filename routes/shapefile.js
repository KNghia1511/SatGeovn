const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const shapefile = require('shapefile');
const logger = require('../config/logger');
const { v4: uuidv4 } = require('uuid');
const pool = require('../db');

const router = express.Router();

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + uuidv4();
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const validExtensions = ['.shp', '.shx', '.dbf', '.prj'];
  const ext = path.extname(file.originalname).toLowerCase();
  if (validExtensions.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`Invalid file type: ${ext}. Expected .shp, .shx, .dbf, or .prj`), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024, files: 4 }
}).array('files', 4);

// Middleware xử lý lỗi multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    logger.warn(`Multer error: ${err.message}`);
    return res.status(400).json({ error: err.message });
  } else if (err) {
    logger.warn(`File upload error: ${err.message}`);
    return res.status(400).json({ error: err.message });
  }
  next();
};

router.post('/upload', upload, handleMulterError, async (req, res) => {
  const transactionId = uuidv4();
  logger.info(`[${transactionId}] Starting shapefile upload`);

  try {
    if (!req.files || req.files.length < 3) {
      logger.warn(`[${transactionId}] Missing required files`);
      return res.status(400).json({ error: 'Please upload .shp, .shx, and .dbf files' });
    }

    const shpFile = req.files.find(f => f.originalname.toLowerCase().endsWith('.shp'));
    if (!shpFile) {
      logger.warn(`[${transactionId}] No .shp file found`);
      return res.status(400).json({ error: 'No .shp file found' });
    }

    logger.debug(`[${transactionId}] Processing shapefile: ${shpFile.path}`);

    // Đọc shapefile
    const source = await shapefile.open(shpFile.path);
    const features = [];
    let result;
    while ((result = await source.read()) && !result.done) {
      if (result.value.geometry) {
        features.push(result.value);
      }
    }

    if (features.length === 0) {
      logger.warn(`[${transactionId}] No valid features found`);
      return res.status(400).json({ error: 'No valid features found in shapefile' });
    }

    logger.info(`[${transactionId}] Read ${features.length} features`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Xóa các bản ghi cũ với cùng tên
      await client.query('DELETE FROM shapefiles WHERE name = $1', [shpFile.originalname]);

      // Lưu từng feature
      for (const feature of features) {
        const geom = JSON.stringify(feature.geometry);
        const bbox = await client.query(
          'SELECT ST_Envelope(ST_GeomFromGeoJSON($1)) AS bbox',
          [geom]
        );
        await client.query(
          `INSERT INTO shapefiles (name, geom, metadata, bbox)
           VALUES ($1, ST_GeomFromGeoJSON($2), $3, $4)`,
          [
            shpFile.originalname,
            geom,
            feature.properties ? JSON.stringify(feature.properties) : null,
            bbox.rows[0].bbox
          ]
        );
      }

      await client.query('COMMIT');
      logger.info(`[${transactionId}] Successfully saved ${features.length} features`);

      res.status(201).json({
        success: true,
        count: features.length,
        name: shpFile.originalname
      });
    } catch (dbError) {
      await client.query('ROLLBACK');
      logger.error(`[${transactionId}] Database error`, { error: dbError.message });
      throw dbError;
    } finally {
      client.release();
      // Dọn dẹp file tạm
      req.files.forEach(file => {
        try {
          fs.unlinkSync(file.path);
        } catch (cleanError) {
          logger.error(`[${transactionId}] Cleanup error`, { file: file.path, error: cleanError.message });
        }
      });
    }
  } catch (error) {
    logger.error(`[${transactionId}] Processing failed`, { error: error.message });
    res.status(500).json({ error: 'Failed to process shapefile' });
  }
});

router.get('/', async (req, res) => {
  try {
    const { page = 1, limit = 10 } = req.query;
    const offset = (page - 1) * limit;

    const result = await pool.query(
      `SELECT 
        id, 
        name, 
        ST_AsGeoJSON(geom) AS geometry,
        created_at,
        updated_at
       FROM shapefiles
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const countResult = await pool.query('SELECT COUNT(*) FROM shapefiles');

    res.json({
      data: result.rows,
      pagination: {
        total: parseInt(countResult.rows[0].count),
        page: parseInt(page),
        limit: parseInt(limit),
        totalPages: Math.ceil(countResult.rows[0].count / limit)
      }
    });
  } catch (error) {
    logger.error('Failed to fetch shapefiles', { error: error.message });
    res.status(500).json({ error: 'Failed to fetch data' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT 
        id,
        name,
        ST_AsGeoJSON(geom) AS geometry,
        metadata,
        created_at,
        updated_at
       FROM shapefiles
       WHERE id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      logger.warn(`Shapefile not found: ${id}`);
      return res.status(404).json({ error: 'Shapefile not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Failed to fetch shapefile', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Failed to fetch shapefile' });
  }
});

router.get('/:id/geometry', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      'SELECT ST_AsGeoJSON(geom) AS geometry FROM shapefiles WHERE id = $1',
      [id]
    );

    if (result.rowCount === 0) {
      logger.warn(`Shapefile not found: ${id}`);
      return res.status(404).json({ error: 'Shapefile not found' });
    }

    res.json(JSON.parse(result.rows[0].geometry));
  } catch (error) {
    logger.error('Failed to fetch shapefile geometry', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Failed to fetch geometry' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, metadata } = req.body;

    if (!name && !metadata) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    const updates = [];
    const values = [];
    let counter = 1;

    if (name) {
      updates.push(`name = $${counter}`);
      values.push(name);
      counter++;
    }

    if (metadata) {
      updates.push(`metadata = $${counter}`);
      values.push(JSON.stringify(metadata));
      counter++;
    }

    values.push(id);
    const query = `
      UPDATE shapefiles
      SET ${updates.join(', ')}, updated_at = NOW()
      WHERE id = $${counter}
      RETURNING *
    `;

    const result = await pool.query(query, values);
    if (result.rowCount === 0) {
      logger.warn(`Shapefile not found: ${id}`);
      return res.status(404).json({ error: 'Shapefile not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Failed to update shapefile', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Failed to update shapefile' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM shapefiles WHERE id = $1', [id]);
    if (result.rowCount === 0) {
      logger.warn(`Shapefile not found: ${id}`);
      return res.status(404).json({ error: 'Shapefile not found' });
    }
    res.status(204).end();
  } catch (error) {
    logger.error('Failed to delete shapefile', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Failed to delete shapefile' });
  }
});

router.get('/:id/geojson', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT 
        json_build_object(
          'type', 'FeatureCollection',
          'features', json_agg(
            json_build_object(
              'type', 'Feature',
              'geometry', ST_AsGeoJSON(geom)::json,
              'properties', COALESCE(metadata, '{}'::json)
            )
          )
        ) AS geojson
       FROM shapefiles
       WHERE id = $1
       GROUP BY id`,
      [id]
    );

    if (!result.rows[0]?.geojson) {
      logger.warn(`Shapefile not found: ${id}`);
      return res.status(404).json({ error: 'No data found' });
    }

    res.setHeader('Content-Type', 'application/geo+json');
    res.send(JSON.stringify(result.rows[0].geojson));
  } catch (error) {
    logger.error('Failed to export GeoJSON', { id: req.params.id, error: error.message });
    res.status(500).json({ error: 'Failed to export data' });
  }
});

module.exports = router;