import sys
import json
import rasterio
import numpy as np
import cv2
import requests
import os
from rasterio.mask import mask
from shapely.geometry import shape

def download_image(image_url, save_path):
    """Tải ảnh từ URL về server"""
    response = requests.get(image_url, stream=True)
    if response.status_code == 200:
        with open(save_path, 'wb') as file:
            for chunk in response.iter_content(1024):
                file.write(chunk)
        return save_path
    print(f"❌ Lỗi tải ảnh: {response.status_code}")
    return None

def calculate_index(image, index_type):
    """Tính NDVI, NDBI, NDWI từ ảnh"""
    blue, green, red, nir = image[:4]
    
    if index_type == "ndvi":
        result = (nir - red) / (nir + red + 1e-10)
    elif index_type == "ndbi":
        result = (nir - green) / (nir + green + 1e-10)
    elif index_type == "ndwi":
        result = (green - nir) / (green + nir + 1e-10)
    else:
        raise ValueError(f"Invalid index: {index_type}")
    
    return result

def process_image(image_path, index_type, shp_geojson_path):
    """Xử lý ảnh: cắt theo SHP, tính chỉ số, xuất GeoTIFF và PNG"""
    # Đọc geometry từ GeoJSON
    with open(shp_geojson_path, 'r') as f:
        geojson = json.load(f)
    geometry = shape(geojson)

    # Mở ảnh và cắt theo SHP
    with rasterio.open(image_path) as src:
        out_image, out_transform = mask(src, [geometry], crop=True)
        out_profile = src.profile.copy()
    
    # Cập nhật profile cho ảnh đã cắt
    out_profile.update({
        'height': out_image.shape[1],
        'width': out_image.shape[2],
        'transform': out_transform
    })

    # Tính chỉ số
    index_result = calculate_index(out_image, index_type.lower())

    # Lưu GeoTIFF
    geotiff_path = image_path.replace('.tif', f'_{index_type}.tif')
    out_profile.update(count=1, dtype=rasterio.float32, nodata=0)
    with rasterio.open(geotiff_path, 'w', **out_profile) as dst:
        dst.write(index_result, 1)

    # Tạo preview PNG
    normalized = cv2.normalize(index_result, None, 0, 255, cv2.NORM_MINMAX, cv2.CV_8U)
    colored = cv2.applyColorMap(normalized, cv2.COLORMAP_JET)
    preview_path = image_path.replace('.tif', f'_{index_type}_preview.png')
    cv2.imwrite(preview_path, colored)

    print(f"geotiff:{geotiff_path}")
    print(f"preview:{preview_path}")

if __name__ == '__main__':
    if len(sys.argv) != 4:
        print("Usage: python3 process_satellite.py <image_path> <index_type> <shp_geojson_path>")
        sys.exit(1)
    
    image_path = sys.argv[1]
    index_type = sys.argv[2]
    shp_geojson_path = sys.argv[3]
    
    process_image(image_path, index_type, shp_geojson_path)