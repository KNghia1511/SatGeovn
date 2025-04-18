const express = require('express');
const logger = require('../config/logger');
const pool = require('../db');

const router = express.Router();

const SUPPORTED_INDICES = {
  NDVI: {
    collection: 'COPERNICUS/S2_SR',
    bands: ['B8', 'B4'],
    palette: ['#FFFFFF', '#CE7E45', '#DF923D', '#F1B555', '#FCD163', '#99B718', '#74A901', '#66A000', '#529400', '#3E8601', '#207401', '#056201', '#004C00', '#023B01', '#012E01', '#011D01', '#011301'],
    formula: '(B8 - B4)/(B8 + B4)'
  },
  NDWI: {
    collection: 'COPERNICUS/S2_SR',
    bands: ['B3', 'B8'],
    palette: ['#ECE7F2', '#D0D1E6', '#A6BDDB', '#74A9CF', '#3690C0', '#0570B0', '#045A8D', '#023858'],
    formula: '(B3 - B8)/(B3 + B8)'
  },
  NDBI: {
    collection: 'MODIS/006/MCD43A4',
    bands: ['Nadir_Reflectance_Band6', 'Nadir_Reflectance_Band2'],
    palette: ['#FFFFCC', '#FFEDA0', '#FED976', '#FEB24C', '#FD8D3C', '#FC4E2A', '#E31A1C', '#BD0026', '#800026'],
    formula: '(B6 - B2)/(B6 + B2)'
  }
};

router.post('/gee', async (req, res) => {
  try {
    const { type, shapefileId } = req.body;
    const transactionId = require('uuid').v4();
    logger.info(`[${transactionId}] Generating GEE code`, { type, shapefileId });

    if (!type || !SUPPORTED_INDICES[type.toUpperCase()] || !shapefileId) {
      logger.warn(`[${transactionId}] Missing parameters`);
      return res.status(400).json({ error: 'Missing type or shapefileId' });
    }

    const result = await pool.query(
      'SELECT ST_AsGeoJSON(geom) AS geometry FROM shapefiles WHERE id = $1',
      [shapefileId]
    );
    if (!result.rows[0]) {
      logger.warn(`[${transactionId}] Shapefile not found: ${shapefileId}`);
      return res.status(404).json({ error: 'Shapefile not found' });
    }

    const geometry = JSON.parse(result.rows[0].geometry);
    const upperType = type.toUpperCase();
    const { collection, bands, palette, formula } = SUPPORTED_INDICES[upperType];

    const geeCode = `
var geometry = ee.Geometry(${JSON.stringify(geometry)});
var collection = ee.ImageCollection("${collection}")
  .filterBounds(geometry)
  .filterDate('2023-01-01', '2023-12-31');
var image = collection.median()
  .normalizedDifference(${JSON.stringify(bands)});
Map.centerObject(geometry, 10);
Map.addLayer(image, {
  min: 0,
  max: 1,
  palette: ${JSON.stringify(palette)},
  opacity: 0.8
}, '${upperType} Index');
`;

    res.json({
      success: true,
      type: upperType,
      gee_code: geeCode.trim(),
      formula,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error(`[${transactionId}] Export failed`, { error: error.message });
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;