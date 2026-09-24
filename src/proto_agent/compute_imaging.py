"""Bounded image-based analyses adapted from Biomni.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: images arrive as workspace bytes decoded in memory (cv2.imdecode
/ skimage.io.imread over buffers) instead of arbitrary host paths; annotated
copy images and CSV artifacts are not written; the colony counter keeps
upstream's Otsu/morphology/distance pipeline and replaces cv2.watershed with
distance-threshold connected components (touching-colony splitting is not
reproduced and is documented). Requires the optional imaging dependencies.
"""

from __future__ import annotations

import math


def _decode_image(files, field):
    raw = files.get(field)
    if raw is None:
        raise ValueError(f"{field} must reference an image file inside the workspace.")
    import cv2
    import numpy as np

    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("The image could not be decoded; supply a supported grayscale-readable format (PNG/JPEG/TIFF).")
    if image.size > 40_000_000:
        raise ValueError("Image exceeds the 40-megapixel offline limit.")
    return image


def _number(value, name, *, minimum=None, maximum=None, positive=False):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a finite number.")
    result = float(value)
    if not math.isfinite(result) or abs(result) > 1e100:
        raise ValueError(f"{name} must be finite with magnitude <= 1e100.")
    if positive and result <= 0:
        raise ValueError(f"{name} must be positive.")
    if minimum is not None and result < minimum or maximum is not None and result > maximum:
        raise ValueError(f"{name} is outside its allowed range.")
    return result


def analyze_pixel_distribution(arguments, files):
    image = _decode_image(files, "image_path")
    import numpy as np

    percentiles = [1, 5, 10, 25, 50, 75, 90, 95, 99]
    histogram, _edges = np.histogram(image, bins=256, range=(0, 256))
    total = int(image.size)
    buckets = [(0, 20), (20, 50), (50, 80), (80, 110), (110, 140), (140, 170), (170, 200), (200, 256)]
    distribution = [{"range": [low, high], "pixels": int(histogram[low:high].sum()),
                     "percent": round(int(histogram[low:high].sum()) / total * 100, 4) if total else 0.0}
                    for low, high in buckets]
    return {
        "shape": [int(image.shape[0]), int(image.shape[1])],
        "intensity_stats": {"min": int(image.min()), "max": int(image.max()),
                            "mean": round(float(image.mean()), 4), "std_dev": round(float(image.std()), 4)},
        "percentiles": {"labels": percentiles, "values": [round(float(v), 4) for v in np.percentile(image, percentiles)]},
        "pixel_brightness_distribution": distribution,
        "method": "Grayscale percentile, histogram, and fixed brightness-bucket statistics transcribed from upstream",
        "limitations": ["Grayscale conversion uses OpenCV luminance decoding; color-channel statistics are not reported.",
                        "Thresholds and buckets are upstream fixed constants, not assay-specific calibrations."],
    }


def count_bacterial_colonies(arguments, files):
    image = _decode_image(files, "image_path")
    dilution_factor = _number(arguments.get("dilution_factor", 1), "dilution_factor", minimum=0)
    plate_area = _number(arguments.get("plate_area_cm2", 25.0), "plate_area_cm2", positive=True, maximum=1e6)
    import cv2
    import numpy as np
    from scipy import ndimage

    blurred = cv2.GaussianBlur(image, (7, 7), 0)
    _threshold, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    kernel = np.ones((3, 3), np.uint8)
    opening = cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel, iterations=2)
    distance = cv2.distanceTransform(opening, cv2.DIST_L2, 5)
    sure_foreground = (distance > 0.5 * distance.max()).astype(np.uint8)
    labels, count = ndimage.label(sure_foreground)
    sizes = ndimage.sum(sure_foreground, labels, range(1, count + 1))
    kept = int((sizes >= 5).sum())
    cfu_per_ml = kept * dilution_factor
    return {
        "colony_count": kept, "rejected_small_blobs": count - kept,
        "cfu_per_ml": round(cfu_per_ml, 4), "cfu_per_cm2": round(cfu_per_ml / plate_area, 6),
        "dilution_factor": dilution_factor, "plate_area_cm2": plate_area,
        "colony_sizes_pixels": [int(size) for size in sorted(sizes, reverse=True)[:200]],
        "method": "Upstream Otsu + morphology + distance-transform pipeline; distance-threshold components replace cv2.watershed",
        "limitations": ["Touching colonies that never separate at half the maximum distance are counted as one; upstream used watershed seeds for the same situation.",
                        "Agar edges, bubbles, and lighting gradients produce false positives; verify counts against manual review.",
                        "Dilution arithmetic multiplies the counted colonies exactly as upstream (no volume correction beyond the supplied factor)."],
    }


def analyze_western_blot(arguments, files):
    raw = files.get("blot_image_path")
    if raw is None:
        raise ValueError("blot_image_path must reference an image file inside the workspace.")
    import cv2
    import numpy as np

    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError("The image could not be decoded; supply a supported grayscale-readable format (PNG/JPEG/TIFF).")
    if image.size > 40_000_000:
        raise ValueError("Image exceeds the 40-megapixel offline limit.")
    loading = arguments.get("loading_control_band")
    targets = arguments.get("target_bands")
    if not isinstance(loading, dict) or set(loading) != {"name", "roi"}:
        raise ValueError("loading_control_band must contain name and roi.")
    if not isinstance(targets, list) or not 1 <= len(targets) <= 50:
        raise ValueError("target_bands must contain 1 to 50 entries.")

    def parse_roi(roi, label):
        if (not isinstance(roi, list) or len(roi) != 4
                or any(isinstance(v, bool) or not isinstance(v, int) for v in roi)):
            raise ValueError(f"{label} roi must be [x, y, width, height] integers.")
        x, y, width, height = roi
        if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > image.shape[1] or y + height > image.shape[0]:
            raise ValueError(f"{label} roi falls outside the image.")
        return float(image[y:y + height, x:x + width].sum())

    def parse_band(band, index):
        if not isinstance(band, dict) or set(band) != {"name", "roi"}:
            raise ValueError(f"target_bands[{index}] must contain name and roi.")
        return {"name": str(band["name"])[:100], "intensity": parse_roi(band["roi"], f"target_bands[{index}]")}

    control_intensity = parse_roi(loading["roi"], "loading_control_band")
    if control_intensity <= 0:
        raise ValueError("The loading-control ROI has zero intensity; check the image and ROI.")
    bands = [parse_band(band, index) for index, band in enumerate(targets)]
    for band in bands:
        band["relative_expression"] = round(band["intensity"] / control_intensity, 6)
    return {
        "loading_control": {"name": str(loading["name"])[:100], "intensity": control_intensity},
        "targets": bands,
        "image_shape": [int(image.shape[0]), int(image.shape[1])],
        "method": "ROI densitometry (grayscale sums normalized to the loading control), transcribed from upstream",
        "limitations": ["Background subtraction is not performed; local background inflates low-signal bands.",
                        "Saturation (clipped bright pixels) breaks the linear intensity assumption.",
                        "Relative expression is an imaging measurement, not protein abundance without a calibration curve.",
                        "Intensity is the raw grayscale sum exactly as upstream; for dark-band (negative-stain) images the ordering inverts."],
    }


_IMAGE_FILE = {"image_path": {"extensions": [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"], "max_bytes": 64 * 1024 * 1024}}
_BLOT_FILE = {"blot_image_path": {"extensions": [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"], "max_bytes": 64 * 1024 * 1024}}


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


def _tool(title, description, schema, example, path, function, dependency, file_inputs):
    return {"title": title, "description": description, "input_schema": schema, "example": example,
            "dependency": list(dependency), "implementation": "biomni-adapted", "file_inputs": file_inputs,
            "upstream_functions": [{"path": path, "name": function}]}


TOOLS = {
    "analyze_pixel_distribution": _tool(
        "Blot image pixel distribution", "Report grayscale percentiles, intensity statistics, and fixed brightness buckets for an electrophoresis or blot image.",
        _schema({"image_path": {"type": "string", "minLength": 1, "maxLength": 400}}, ["image_path"]),
        {"image_path": "build/compute-inputs/blot.png"},
        "biomni/tool/pharmacology.py", "analyze_pixel_distribution", ("numpy", "cv2"), _IMAGE_FILE),
    "count_bacterial_colonies": _tool(
        "Agar plate colony counting", "Count colonies with the Otsu/morphology/distance-transform pipeline and convert to CFU density.",
        _schema({"image_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "dilution_factor": {"type": "number", "minimum": 0, "default": 1},
                 "plate_area_cm2": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6, "default": 25}}, ["image_path"]),
        {"image_path": "build/compute-inputs/plate.png", "dilution_factor": 10, "plate_area_cm2": 25},
        "biomni/tool/microbiology.py", "count_bacterial_colonies", ("numpy", "scipy", "cv2"), _IMAGE_FILE),
    "analyze_western_blot": _tool(
        "Western blot densitometry", "Quantify loading-control-normalized band intensities from ROI rectangles on a blot image.",
        _schema({"blot_image_path": {"type": "string", "minLength": 1, "maxLength": 400},
                 "loading_control_band": _schema({"name": {"type": "string", "minLength": 1, "maxLength": 100},
                                                  "roi": {"type": "array", "minItems": 4, "maxItems": 4, "items": {"type": "integer", "minimum": 0}}}, ["name", "roi"]),
                 "target_bands": {"type": "array", "minItems": 1, "maxItems": 50, "items": _schema(
                     {"name": {"type": "string", "minLength": 1, "maxLength": 100},
                      "roi": {"type": "array", "minItems": 4, "maxItems": 4, "items": {"type": "integer", "minimum": 0}}}, ["name", "roi"])}},
                ["blot_image_path", "loading_control_band", "target_bands"]),
        {"blot_image_path": "build/compute-inputs/blot.png",
         "loading_control_band": {"name": "actin", "roi": [10, 10, 40, 20]},
         "target_bands": [{"name": "target_1", "roi": [10, 50, 40, 20]}]},
        "biomni/tool/pharmacology.py", "analyze_western_blot", ("numpy", "cv2"), _BLOT_FILE),
}
HANDLERS = {name: globals()[name] for name in TOOLS}
