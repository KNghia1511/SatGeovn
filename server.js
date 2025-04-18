require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const logger = require('./config/logger');
const pool = require('./db');

const app = express();

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/data', express.static(path.join(__dirname, 'data'))); // Phục vụ file preview

app.use((req, res, next) => {
  logger.http(`${req.method} ${req.url}`);
  next();
});

const satelliteRoutes = require("./routes/satellite");
const shapefileRoutes = require("./routes/shapefile");
const exportRoutes = require("./routes/export");

app.use("/api/satellite", satelliteRoutes);
app.use("/api/shapefile", shapefileRoutes);
app.use("/api/export", exportRoutes);

// Khởi tạo bảng shapefiles
const initTable = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shapefiles (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        geom GEOMETRY NOT NULL,
        bbox GEOMETRY,
        metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS shapefiles_geom_idx ON shapefiles USING GIST(geom);
      CREATE INDEX IF NOT EXISTS shapefiles_bbox_idx ON shapefiles USING GIST(bbox);
    `);
    logger.info("Database table initialized");
  } catch (error) {
    logger.error("Failed to initialize database table", { error: error.message });
    throw error;
  }
};

// Test connection và khởi tạo bảng
pool.query('SELECT NOW()')
  .then(res => {
    logger.info("✅ Database connected at:", res.rows[0].now);
    return initTable();
  })
  .catch(err => {
    logger.error("❌ Database connection failed:", err.message);
    process.exit(1);
  });

app.use((err, req, res, next) => {
  logger.error('Unhandled error', {
    error: err.message,
    request: { method: req.method, url: req.url }
  });
  res.status(500).json({ error: "Internal server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  logger.info(`Server started on port ${PORT}`);
  console.log(`🚀 Server is running on port ${PORT}`);
});

module.exports = { app, pool };