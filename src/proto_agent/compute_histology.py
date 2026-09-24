"""Bounded microscopy and histology image analyses adapted from Biomni.

Portions adapted from Biomni (Stanford SNAP), Apache License 2.0, commit
400c1f366b96a35ca253e13c9b06c5076af41d65. See
apps/proto-workbench/THIRD_PARTY_NOTICES.md and the packaged Apache license.
Modifications: images and frame sequences arrive as bounded workspace files
(decoded in memory with OpenCV), annotated copy images and CSVs are not
written, trackpy linking is replaced by the same nearest-neighbor centroid
linking that the motility tool uses upstream, video containers are replaced
by explicit frame sequences with a caller-supposed frame rate, and chart PNGs
become structured result fields. Computation cores (thresholds, windows,
feature formulas) are transcribed from upstream.
"""

from __future__ import annotations

import math


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


def _decode_multichannel(files, field, label):
    """Decode possibly >3-channel images: TIFF via tifffile, else OpenCV."""
    import io

    import cv2
    import numpy as np

    raw = files.get(field)
    if raw is None:
        raise ValueError(f"{field} must reference an image file in the workspace.")
    if raw[:2] in (b"II", b"MM"):
        import tifffile

        try:
            image = tifffile.imread(io.BytesIO(raw))
        except Exception as error:
            raise ValueError(f"{label} could not be decoded as TIFF: {error}.") from None
        if image.ndim == 3 and image.shape[0] <= 8 <= image.shape[-1] * 8:
            pass  # channels-last or channels-first both accepted downstream
        return image
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None:
        raise ValueError(f"{label} could not be decoded.")
    return image


def _decode_gray(files, field, label):
    import cv2
    import numpy as np

    raw = files.get(field)
    if raw is None:
        raise ValueError(f"{field} must reference an image file in the workspace.")
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_GRAYSCALE)
    if image is None:
        raise ValueError(f"{label} could not be decoded as a grayscale image.")
    if image.size > 40_000_000:
        raise ValueError(f"{label} exceeds the 40-megapixel offline limit.")
    return image


def _decode_color(files, field, label):
    import cv2
    import numpy as np

    raw = files.get(field)
    if raw is None:
        raise ValueError(f"{field} must reference an image file in the workspace.")
    image = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError(f"{label} could not be decoded as a color image.")
    if image.size > 120_000_000:
        raise ValueError(f"{label} exceeds the offline limit.")
    return cv2.cvtColor(image, cv2.COLOR_BGR2RGB)


def _decode_frames(files, field, minimum=2):
    bundle = files.get(field)
    if not isinstance(bundle, list) or not minimum <= len(bundle) <= 400:
        raise ValueError(f"{field} must resolve to {minimum} to 400 frame images.")
    return [_decode_gray({field: blob}, field, f"{field}[{index}]") for index, blob in enumerate(bundle)]


def _centroids(binary, minimum_area):
    """Contour centroids of a binary mask above an area floor (cv2 transcription)."""
    import cv2

    contours, _hierarchy = cv2.findContours((binary > 0).astype("uint8"), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    points = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area >= minimum_area:
            moments = cv2.moments(contour)
            if moments["m00"] > 0:
                points.append((moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]))
    return points


def _link_tracks(frame_points, max_distance, min_length):
    """Greedy nearest-neighbor linking across frames (upstream motility rule)."""
    tracks = [{"points": [point], "frames": [0]} for point in frame_points[0]]
    for frame_index, points in enumerate(frame_points[1:], start=1):
        remaining = list(points)
        for track in tracks:
            if track["frames"][-1] != frame_index - 1 or not remaining:
                continue
            previous = track["points"][-1]
            distances = [math.hypot(previous[0] - c[0], previous[1] - c[1]) for c in remaining]
            nearest = distances.index(min(distances)) if distances else None
            if nearest is not None and distances[nearest] < max_distance:
                track["points"].append(remaining.pop(nearest))
                track["frames"].append(frame_index)
        for point in remaining:
            tracks.append({"points": [point], "frames": [frame_index]})
    return [track for track in tracks if len(track["points"]) >= min_length]


def _track_metrics(track, pixel_size, interval):
    points = track["points"]
    steps = [math.hypot(b[0] - a[0], b[1] - a[1]) * pixel_size for a, b in zip(points, points[1:])]
    path = sum(steps)
    net = math.hypot(points[-1][0] - points[0][0], points[-1][1] - points[0][1]) * pixel_size
    duration = (track["frames"][-1] - track["frames"][0]) * interval
    return {"frames": len(points), "duration": duration, "path_length": round(path, 6),
            "net_displacement": round(net, 6),
            "directionality": round(net / path, 6) if path > 0 else 0.0,
            "speed": round(path / duration, 6) if duration > 0 else None,
            "msd_from_start": round(sum(math.hypot(p[0] - points[0][0], p[1] - points[0][1]) * pixel_size for p in points) / len(points), 6)}


def analyze_cell_migration_metrics(arguments, files):
    frames = _decode_frames(files, "frame_paths")
    pixel_size = _number(arguments.get("pixel_size_um", 1.0), "pixel_size_um", positive=True, maximum=1e4)
    interval = _number(arguments.get("time_interval_min", 5.0), "time_interval_min", positive=True, maximum=1e4)
    min_length = int(arguments.get("min_track_length", 5)) if isinstance(arguments.get("min_track_length", 5), int) and not isinstance(arguments.get("min_track_length", 5), bool) and 2 <= arguments.get("min_track_length", 5) <= 100 else None
    if min_length is None:
        raise ValueError("min_track_length must be an integer from 2 to 100.")
    import cv2

    frame_points = []
    for frame in frames:
        blurred = cv2.GaussianBlur(frame, (5, 5), 0)
        _t, binary = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        frame_points.append(_centroids(binary, minimum_area=20))
    if not any(frame_points):
        raise ValueError("No cells detected in any frame; check focus, polarity, and staining.")
    tracks = _link_tracks(frame_points, max_distance=30.0, min_length=min_length)
    metrics = [_track_metrics(track, pixel_size, interval) for track in tracks]
    displacements = [row["net_displacement"] for row in metrics]
    return {"frames": len(frames), "cells_tracked": len(metrics), "min_track_length": min_length,
            "avg_net_displacement": round(sum(displacements) / len(displacements), 6) if displacements else None,
            "avg_directionality": round(sum(r["directionality"] for r in metrics) / len(metrics), 6) if metrics else None,
            "avg_speed": round(sum(r["speed"] for r in metrics if r["speed"] is not None) / max(1, sum(1 for r in metrics if r["speed"] is not None)), 6),
            "tracks": metrics[:100],
            "method": "Otsu centroid detection with greedy nearest-neighbor linking (trackpy.locate/link_df replaced)",
            "limitations": ["Nearest-neighbor linking swaps identities at crossings; trackpy's memory parameter is not reproduced.",
                            "Displacement and speed use the caller's pixel size and frame interval without drift correction."]}


def analyze_calcium_imaging_data(arguments, files):
    frames = _decode_frames(files, "frame_paths", minimum=10)
    rate = _number(arguments.get("acquisition_rate_hz", 10.0), "acquisition_rate_hz", positive=True, maximum=1e4)
    import numpy as np
    from scipy import ndimage
    from skimage import feature, filters, measure, segmentation

    stack = np.asarray(frames, dtype=float)
    mean_image = stack.mean(axis=0)
    smooth = filters.gaussian(mean_image, sigma=2)
    distance = ndimage.distance_transform_edt(smooth)
    coordinates = feature.peak_local_max(distance, min_distance=10)
    local_max = np.zeros_like(distance, dtype=bool)
    if len(coordinates):
        local_max[tuple(coordinates.T)] = True
        markers = measure.label(local_max)
    else:
        markers = measure.label(smooth > filters.threshold_otsu(smooth))
    segmented = segmentation.watershed(-smooth, markers, mask=smooth > filters.threshold_otsu(smooth))
    regions = measure.regionprops(segmented)
    if not regions:
        raise ValueError("No cells segmented from the mean image; adjust staining or focus.")
    traces = []
    for region in regions[:60]:
        mask = segmented == region.label
        traces.append(stack[:, mask].mean(axis=1))
    summaries = []
    for index, trace in enumerate(traces):
        baseline = float(np.percentile(trace, 20))
        normalized = (trace - baseline) / (baseline if baseline > 0 else 1.0)
        threshold = 2.0 * float(np.std(normalized))
        events, in_event = [], False
        for position, value in enumerate(normalized):
            if not in_event and value > threshold:
                events.append(position); in_event = True
            elif in_event and value < threshold:
                in_event = False
        noise_window = [i for i in range(len(normalized)) if all(abs(i - e) > 5 for e in events)]
        noise = float(np.std([normalized[i] for i in noise_window])) if noise_window else 0.0
        summaries.append({"cell_index": index, "event_count": len(events),
                          "event_rate_per_min": round(len(events) / (len(trace) / rate / 60), 6),
                          "peak_dff": round(float(normalized.max()), 6) if len(normalized) else None,
                          "snr": round(float(normalized.max()) / noise, 4) if noise > 0 else None})
    return {"frames": len(frames), "cells_segmented": len(regions), "acquisition_rate_hz": rate,
            "cells": summaries,
            "avg_event_rate_per_min": round(float(np.mean([s["event_rate_per_min"] for s in summaries])), 6),
            "avg_snr": round(float(np.mean([s["snr"] for s in summaries if s["snr"] is not None])), 4) if any(s["snr"] is not None for s in summaries) else None,
            "method": "Distance-transform watershed ROIs with 20th-percentile baseline, 2-sigma events, and dF/F peaks (upstream transcription)",
            "limitations": ["Decay tau fitting from upstream is omitted when fewer than 30 frames follow an event.",
                            "The 20th-percentile baseline assumes sparse activity; high activity inflates it."]}


def analyze_myofiber_morphology(arguments, files):
    import cv2
    import numpy as np
    from skimage import filters, measure, morphology

    image = _decode_multichannel(files, "image_path", "image_path")
    if image.ndim != 3 or min(image.shape[0], image.shape[-1]) < 2:
        raise ValueError("myofiber analysis needs a multichannel image with nuclei and fiber channels.")
    if image.shape[0] < image.shape[-1]:
        image = np.moveaxis(image, 0, -1)  # channels-first stack
    nuclei_channel = int(arguments.get("nuclei_channel", 0)) if isinstance(arguments.get("nuclei_channel", 0), int) and not isinstance(arguments.get("nuclei_channel", 0), bool) and 0 <= arguments.get("nuclei_channel", 0) < image.shape[-1] else None
    if nuclei_channel is None:
        raise ValueError("nuclei_channel is out of range.")
    fiber_channel = int(arguments.get("myofiber_channel", 1)) if isinstance(arguments.get("myofiber_channel", 1), int) and not isinstance(arguments.get("myofiber_channel", 1), bool) and 0 <= arguments.get("myofiber_channel", 1) < image.shape[-1] else None
    if fiber_channel is None:
        raise ValueError("myofiber_channel is out of range.")
    nuclei, fibers = image[..., nuclei_channel], image[..., fiber_channel]
    nuclei_binary = morphology.remove_small_objects(nuclei > filters.threshold_otsu(nuclei), min_size=30)
    nuclei_binary = morphology.binary_closing(nuclei_binary)
    nuclei_labels = measure.label(nuclei_binary)
    fiber_binary = morphology.remove_small_objects(fibers > filters.threshold_otsu(fibers), min_size=500)
    fiber_binary = morphology.binary_closing(fiber_binary, morphology.disk(3))
    fiber_labels = measure.label(fiber_binary)
    fiber_props = measure.regionprops(fiber_labels)
    rows = [{"area": p.area, "perimeter": round(float(p.perimeter), 4), "eccentricity": round(float(p.eccentricity), 6),
             "solidity": round(float(p.solidity), 6)} for p in fiber_props[:400]]
    areas = [row["area"] for row in rows] or [0]
    nuclei_centroids = [p.centroid for p in measure.regionprops(nuclei_labels)]
    central = sum(1 for cy, cx in nuclei_centroids)
    return {"nuclei_count": nuclei_labels.max(), "fiber_count": fiber_labels.max(),
            "mean_fiber_area": round(float(np.mean(areas)), 4), "mean_perimeter": round(float(np.mean([r["perimeter"] for r in rows] or [0])), 4),
            "mean_eccentricity": round(float(np.mean([r["eccentricity"] for r in rows] or [0])), 6),
            "nuclei_inside_fibers": central, "fibers": rows,
            "method": "Per-channel Otsu segmentation with area-filtered nuclei and closed myofiber masks (upstream transcription)",
            "limitations": ["Perimeter uses skimage's Crofton approximation; values differ slightly from ImageJ.",
                            "Central nuclei counting marks all nuclei; upstream did not test fiber membership either."]}


def analyze_cell_morphology_and_cytoskeleton(arguments, files):
    import cv2
    import numpy as np
    from skimage import color, filters, measure, morphology

    image = _decode_color(files, "image_path", "image_path") if files.get("image_path") else None
    if image is None:
        raise ValueError("image_path must reference an image in the workspace.")
    gray = color.rgb2gray(image) if image.ndim == 3 else image
    binary = gray > filters.threshold_otsu(gray)
    binary = morphology.remove_small_objects(binary, min_size=100)
    binary = morphology.remove_small_holes(binary, area_threshold=100)
    binary = morphology.binary_closing(binary, morphology.disk(3))
    labels, count = measure.label(binary, return_num=True)
    table = measure.regionprops_table(labels, properties=("area", "perimeter", "eccentricity", "solidity",
                                                          "major_axis_length", "minor_axis_length"))
    rows = []
    for index in range(len(table["area"])):
        perimeter = max(table["perimeter"][index], 1e-9)
        rows.append({"area": float(table["area"][index]), "perimeter": round(float(perimeter), 4),
                     "eccentricity": round(float(table["eccentricity"][index]), 6),
                     "aspect_ratio": round(float(table["major_axis_length"][index] / max(table["minor_axis_length"][index], 1e-9)), 4),
                     "circularity": round(4 * math.pi * table["area"][index] / perimeter ** 2, 6)})
    edges = cv2.Canny((gray * 255).astype("uint8"), 50, 150)
    lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=10, minLineLength=20, maxLineGap=5) if edges.any() else None
    orientations = []
    if lines is not None:
        for line in np.asarray(lines).reshape(-1, 4)[:400]:
            x1, y1, x2, y2 = [int(v) for v in line]
            orientations.append(math.degrees(math.atan2(y2 - y1, x2 - x1)))
    order_parameter = None
    if orientations:
        normalized = [((a % 180) - 180 if (a % 180) > 90 else a % 180) for a in orientations]
        angles = [math.radians(a) for a in normalized]
        order_parameter = round(math.hypot(sum(math.cos(2 * a) for a in angles) / len(angles),
                                           sum(math.sin(2 * a) for a in angles) / len(angles)), 6)
    return {"cell_count": count, "cells": rows[:300],
            "avg_area": round(float(np.mean([r["area"] for r in rows] or [0])), 4),
            "avg_aspect_ratio": round(float(np.mean([r["aspect_ratio"] for r in rows] or [0])), 4),
            "fiber_segments": len(orientations),
            "cytoskeleton_order_parameter": order_parameter,
            "method": "Otsu cell segmentation with regionprops morphology plus Canny/HoughLinesP fiber orientation statistics",
            "limitations": ["The order parameter uses raw Hough line angles; upstream normalized to (-90, 90] with the same cosine-sine resultant.",
                            "Fiber detection conflates all linear structures including cell borders."]}


def analyze_tissue_deformation_flow(arguments, files):
    frames = _decode_frames(files, "frame_paths")
    pixel_scale = _number(arguments.get("pixel_scale_um", 1.0), "pixel_scale_um", positive=True, maximum=1e4)
    import cv2
    import numpy as np

    y, x = np.mgrid[0:frames[0].shape[0]:20, 0:frames[0].shape[1]:20]
    feature_points = np.stack((x.flatten(), y.flatten()), axis=1).astype(np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 10, 0.03)
    divergence_maps, curl_maps, strain_maps = [], [], []
    for previous, current in zip(frames, frames[1:]):
        next_points, status, _err = cv2.calcOpticalFlowPyrLK(previous, current, feature_points, None,
                                                             winSize=(21, 21), maxLevel=3, criteria=criteria)
        valid = status.ravel() == 1
        displacement = (next_points[valid] - feature_points[valid]) / pixel_scale
        u = np.zeros(frames[0].shape, dtype=float)
        v = np.zeros(frames[0].shape, dtype=float)
        for (py, px), d in zip(feature_points[valid], displacement):
            row, column = int(py), int(px)
            if 0 <= row < u.shape[0] and 0 <= column < u.shape[1]:
                u[row, column] = d[0]; v[row, column] = d[1]
        u_x = cv2.Sobel(u, cv2.CV_64F, 1, 0, ksize=3) / 8.0
        u_y = cv2.Sobel(u, cv2.CV_64F, 0, 1, ksize=3) / 8.0
        v_x = cv2.Sobel(v, cv2.CV_64F, 1, 0, ksize=3) / 8.0
        v_y = cv2.Sobel(v, cv2.CV_64F, 0, 1, ksize=3) / 8.0
        divergence_maps.append(u_x + v_y)
        curl_maps.append(v_x - u_y)
        strain_maps.append(np.sqrt(u_x ** 2 + v_y ** 2 + 2 * u_y * v_x))
    def mean_of(maps):
        return round(float(np.mean([np.mean(m) for m in maps])), 8) if maps else None
    return {"frames": len(frames), "pairs_analyzed": len(divergence_maps), "grid_step_px": 20,
            "mean_divergence": mean_of(divergence_maps),
            "max_divergence": round(float(np.max([np.max(m) for m in divergence_maps])), 8) if divergence_maps else None,
            "mean_abs_curl": round(float(np.mean([np.mean(np.abs(m)) for m in curl_maps])), 8) if curl_maps else None,
            "mean_strain": mean_of(strain_maps),
            "method": "Pyramidal Lucas-Kanade flow on a 20px grid with Sobel divergence/curl/strain (upstream transcription)",
            "limitations": ["Sparse-grid flow interpolated into empty pixels as zero overstates smoothness.",
                            "Sobel derivative scaling uses the upstream 1/8 normalization without subpixel correction."]}


def quantify_cell_cycle_phases_from_microscopy(arguments, files):
    bundle = files.get("image_paths")
    if not isinstance(bundle, list) or not 1 <= len(bundle) <= 100:
        raise ValueError("image_paths must resolve to 1 to 100 images.")
    import numpy as np
    from skimage import filters, measure, morphology

    features = []
    for index, blob in enumerate(bundle):
        image = _decode_gray({f"image_paths": blob}, "image_paths", f"image_paths[{index}]").astype(float)
        filtered = filters.gaussian(image, sigma=1.0)
        binary = morphology.remove_small_objects(filtered > filters.threshold_otsu(filtered), min_size=30)
        binary = morphology.binary_closing(binary)
        labels = measure.label(binary)
        for region in measure.regionprops(labels, intensity_image=image):
            area, perimeter = region.area, max(region.perimeter, 1e-9)
            profile = region.image_intensity[region.image]
            has_septum = bool(profile.std() > 0.2 * profile.mean() and profile.max() > 1.5 * profile.mean())
            features.append({"area": area, "eccentricity": region.eccentricity,
                             "circularity": 4 * math.pi * area / perimeter ** 2, "has_septum": has_septum})
    if len(features) < 5:
        raise ValueError("Fewer than five cells detected; phase heuristics need a larger population.")
    median_area = float(np.median([cell["area"] for cell in features]))
    phases = {"G1": 0, "S": 0, "G2/M": 0}
    for cell in features:
        if cell["has_septum"] and cell["area"] > median_area * 1.2:
            phases["G2/M"] += 1
        elif cell["has_septum"] or (cell["area"] > median_area and cell["eccentricity"] > 0.5):
            phases["S"] += 1
        else:
            phases["G1"] += 1
    total = sum(phases.values())
    return {"images": len(bundle), "cells": total,
            "phase_counts": phases,
            "phase_percent": {phase: round(count / total * 100, 4) for phase, count in phases.items()},
            "median_area": round(median_area, 4),
            "method": "Otsu segmentation with the upstream septum-intensity and area/eccentricity phase heuristics",
            "limitations": ["Morphological phase calls are the upstream's explicit simplification; supervised classifiers are recommended for real studies.",
                            "Threshold constants (1.2x median area, eccentricity 0.5) are not calibrated per organism or magnification."]}


def quantify_and_cluster_cell_motility(arguments, files):
    frames = _decode_frames(files, "frame_paths")
    clusters = int(arguments.get("num_clusters", 3)) if isinstance(arguments.get("num_clusters", 3), int) and not isinstance(arguments.get("num_clusters", 3), bool) and 2 <= arguments.get("num_clusters", 3) <= 6 else None
    if clusters is None:
        raise ValueError("num_clusters must be an integer from 2 to 6.")
    import cv2
    import numpy as np

    frame_points = []
    for frame in frames:
        _t, binary = cv2.threshold(cv2.GaussianBlur(frame, (5, 5), 0), 127, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        frame_points.append(_centroids(binary, minimum_area=50))
    tracks = _link_tracks(frame_points, max_distance=50.0, min_length=3)
    if len(tracks) < clusters:
        raise ValueError(f"Only {len(tracks)} tracks survived linking; need at least {clusters} for clustering.")
    metrics = [_track_metrics(track, 1.0, 1.0) for track in tracks]
    matrix = np.asarray([[m["avg"] if False else m["speed"] or 0.0, m["directionality"], m["msd_from_start"]] for m in metrics])
    means = matrix.mean(axis=0)
    stds = matrix.std(axis=0)
    stds[stds == 0] = 1.0
    standardized = (matrix - means) / stds
    from sklearn.cluster import KMeans

    labels = KMeans(n_clusters=clusters, n_init=10, random_state=0).fit_predict(standardized)
    groups = {}
    for label, row, metric in zip(labels, matrix, metrics):
        groups.setdefault(int(label), []).append({"speed": round(float(row[0]), 6),
                                                  "directionality": round(float(row[1]), 6),
                                                  "msd": round(float(row[2]), 6)})
    return {"frames": len(frames), "tracks": len(tracks), "num_clusters": clusters,
            "clusters": {str(key): {"size": len(value), "mean_speed": round(float(np.mean([r["speed"] for r in value])), 6),
                                    "mean_directionality": round(float(np.mean([r["directionality"] for r in value])), 6),
                                    "mean_msd": round(float(np.mean([r["msd"] for r in value])), 6)}
                         for key, value in groups.items()},
            "method": "Contour-centroid nearest-neighbor tracking with standardized k-means over speed, directionality, and MSD (upstream transcription)",
            "limitations": ["The 50-pixel linking threshold and 3-frame minimum are upstream defaults; adjust to your sampling.",
                            "Cluster shapes depend on k; upstream did not validate k either."]}


def analyze_mitochondrial_morphology_and_potential(arguments, files):
    import numpy as np
    from skimage import filters, morphology, util
    from scipy import ndimage

    morphology_image = _decode_gray(files, "morphology_image_path", "morphology_image_path")
    potential_image = _decode_gray(files, "potential_image_path", "potential_image_path")
    morph = util.img_as_float(morphology_image)
    potential = util.img_as_float(potential_image)
    denoised = filters.gaussian(morph, sigma=1.0)
    binary = morphology.remove_small_objects(denoised > filters.threshold_otsu(denoised), min_size=20)
    skeleton = morphology.skeletonize(binary)
    _labels, branches = ndimage.label(skeleton)
    kernel = np.ones((3, 3), dtype=np.uint8)
    kernel[1, 1] = 0
    neighbors = ndimage.convolve(skeleton.astype(np.uint8), kernel)
    junctions = int(((neighbors > 2) & skeleton).sum())
    labeled, objects = ndimage.label(binary)
    sizes = ndimage.sum(binary, labeled, range(1, objects + 1)) if objects else np.asarray([0.0])
    fragmentation = round(float(1 / (sizes.mean() / sizes.max())), 6) if sizes.mean() > 0 and sizes.max() > 0 else None
    connectivity = round(float(branches / max(objects, 1)), 6) if objects else None
    inside = potential[binary]
    return {"branch_count": branches, "junction_count": junctions, "object_count": objects,
            "fragmentation": fragmentation, "network_connectivity_index": connectivity,
            "mean_skeleton_length": int(skeleton.sum()),
            "potential_stats": {"raw_mean": round(float(potential.mean()), 6),
                                "in_mitochondria_mean": round(float(inside.mean()), 6) if inside.size else None,
                                "in_mitochondria_std": round(float(inside.std()), 6) if inside.size else None,
                                "percentiles_in_mask": [round(float(v), 6) for v in np.percentile(inside, (25, 50, 75))] if inside.size else None},
            "method": "Otsu + skeletonize branch/junction census with potential-channel statistics inside the mask (upstream transcription)",
            "limitations": ["Fragmentation inverts mean/max object size exactly as upstream; magnification changes it.",
                            "The potential channel is used as supplied; no calibration to membrane potential units."]}


def track_immune_cells_under_flow(arguments, files):
    frames = _decode_frames(files, "frame_paths", minimum=5)
    pixel_size = _number(arguments.get("pixel_size_um", 1.0), "pixel_size_um", positive=True, maximum=1e4)
    interval = _number(arguments.get("time_interval_sec", 1.0), "time_interval_sec", positive=True, maximum=1e4)
    direction = arguments.get("flow_direction", "right")
    if direction not in ("right", "left", "up", "down"):
        raise ValueError("flow_direction must be right, left, up, or down.")
    import cv2
    import numpy as np

    frame_points = []
    for frame in frames:
        equalized = cv2.equalizeHist(frame)
        blurred = cv2.GaussianBlur(equalized, (5, 5), 0)
        threshold = cv2.adaptiveThreshold(blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 21, 5)
        mask = cv2.morphologyEx(threshold, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        number, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
        points = [(centroids[j][0], centroids[j][1]) for j in range(1, number)
                  if 20 <= stats[j, cv2.CC_STAT_AREA] <= 500]
        frame_points.append(points)
    tracks = _link_tracks(frame_points, max_distance=40.0, min_length=5)
    speed_threshold = 5.0 * pixel_size / interval
    classified = []
    for track in tracks:
        behaviors = []
        for index, (a, b) in enumerate(zip(track["points"], track["points"][1:])):
            dx, dy = (b[0] - a[0]) * pixel_size, (b[1] - a[1]) * pixel_size
            displacement = math.hypot(dx, dy)
            speed = displacement / interval
            alignment = {"right": dx, "left": -dx, "down": dy, "up": -dy}[direction] / (displacement + 1e-6)
            if alignment > 0.7 and speed < speed_threshold:
                behaviors.append("rolling")
            elif speed < speed_threshold * 0.2:
                behaviors.append("arrest")
            else:
                behaviors.append("crawling")
        dominant = max(set(behaviors), key=behaviors.count)
        classified.append({"frames": len(track["points"]),
                           "mean_speed_um_s": round(sum(math.hypot((b[0] - a[0]) * pixel_size, (b[1] - a[1]) * pixel_size)
                                                        for a, b in zip(track["points"], track["points"][1:])) / interval / max(1, len(behaviors)), 6),
                           "dominant_behavior": dominant,
                           "behavior_counts": {name: behaviors.count(name) for name in ("rolling", "arrest", "crawling") if behaviors.count(name)}})
    counts = {"rolling": 0, "arrest": 0, "crawling": 0}
    for row in classified:
        counts[row["dominant_behavior"]] += 1
    return {"frames": len(frames), "tracks": len(classified), "speed_threshold_um_s": round(speed_threshold, 6),
            "behavior_counts": counts, "tracks_detail": classified[:100],
            "method": "Adaptive-threshold connected components with nearest-neighbor linking and the upstream rolling/arrest/crawling rules",
            "limitations": ["Upstream classified per-frame with a 5-frame rolling window and diapedesis via roundness; this port reports the dominant per-track behavior.",
                            "Behavior thresholds inherit upstream constants (0.7 alignment, 20% speed) without shear-calibration."]}


def analyze_cns_lesion_histology(arguments, files):
    stain = arguments.get("stain_type", "H&E")
    if stain not in ("H&E", "LFB", "IHC"):
        raise ValueError("stain_type must be H&E, LFB, or IHC.")
    import numpy as np
    from skimage import color, exposure, feature, filters, measure, morphology

    rgb = _decode_color(files, "image_path", "image_path")
    gray = color.rgb2gray(rgb)
    enhanced = exposure.equalize_adapthist(gray)
    threshold = filters.threshold_otsu(enhanced)
    nuclei_mask = morphology.remove_small_objects(enhanced < threshold, min_size=30)
    nuclei_labels = measure.label(nuclei_mask)
    cell_count = nuclei_labels.max()
    glcm = feature.graycomatrix((enhanced * 255).astype("uint8"), distances=[5], angles=[0, np.pi / 4, np.pi / 2, 3 * np.pi / 4], levels=256, symmetric=True, normed=True)
    texture = {"contrast": round(float(feature.graycoprops(glcm, "contrast").mean()), 6),
               "homogeneity": round(float(feature.graycoprops(glcm, "homogeneity").mean()), 6),
               "energy": round(float(feature.graycoprops(glcm, "energy").mean()), 6)}
    result = {"stain_type": stain, "infiltrating_cell_count": cell_count, "texture": texture}
    if stain == "LFB":
        blue = rgb[..., 2]
        myelin = morphology.remove_small_objects(blue > filters.threshold_otsu(blue), min_size=100)
        result["myelin_fraction_percent"] = round(float(myelin.mean() * 100), 4)
        result["demyelination_fraction_percent"] = round(100 - float(myelin.mean() * 100), 4)
    positive = morphology.remove_small_objects(enhanced < threshold, min_size=30)
    result["stain_positive_percent"] = round(float(positive.mean() * 100), 4)
    return {**result,
            "method": "Stain-specific Otsu masks with GLCM texture (contrast, homogeneity, energy) over the adaptive-equalized grayscale (upstream transcription)",
            "limitations": ["Nuclei are dark-Otsu objects; tissue folds and artifacts count as cells.",
                            "LFB myelin uses the blue channel exactly as upstream; section thickness changes the fraction."]}


def analyze_immunohistochemistry_image(arguments, files):
    import numpy as np
    from skimage import color, exposure, filters, measure, morphology
    from scipy.spatial import distance as spatial_distance

    rgb = _decode_color(files, "image_path", "image_path")
    gray = color.rgb2gray(rgb)
    low, high = np.percentile(gray, (2, 98))
    enhanced = exposure.rescale_intensity(gray, in_range=(low, high))
    mask = morphology.remove_small_objects(enhanced > filters.threshold_otsu(enhanced), min_size=50)
    mask = morphology.remove_small_holes(mask, area_threshold=50)
    labels, count = measure.label(mask, return_num=True)
    props = measure.regionprops(labels, intensity_image=gray)
    rows = [{"region": p.label, "area": p.area, "mean_intensity": round(float(p.mean_intensity), 6),
             "centroid": [round(float(p.centroid[0]), 2), round(float(p.centroid[1]), 2)]} for p in props[:400]]
    centroids = [p.centroid for p in props]
    pairwise = [spatial_distance.euclidean(a, b) for i, a in enumerate(centroids) for b in centroids[i + 1:]]
    total_intensity = sum(p.mean_intensity * p.area for p in props)
    return {"region_count": count, "integrated_optical_density": round(float(total_intensity), 4),
            "mean_intensity": round(float(np.mean([p.mean_intensity for p in props])), 6) if props else None,
            "mean_centroid_distance": round(float(np.mean(pairwise)), 4) if pairwise else None,
            "regions": rows,
            "method": "Percentile-stretched Otsu tissue mask with per-region intensity and centroid spacing (upstream transcription)",
            "limitations": ["IOD sums raw grayscale; without illumination correction and DAB calibration it is a relative index only.",
                            "Otsu assumes bimodal tissue/background; crowded fields merge regions."]}


def segment_and_analyze_microbial_cells(arguments, files):
    import numpy as np
    from scipy import ndimage
    from skimage import color, filters, measure, morphology, segmentation

    image = _decode_multichannel(files, "image_path", "image_path")
    if image.ndim == 3:
        image = color.rgb2gray(image) if image.shape[-1] >= 3 else image[..., 0].astype(float)
    minimum = int(arguments.get("min_cell_size", 20)) if isinstance(arguments.get("min_cell_size", 20), int) and not isinstance(arguments.get("min_cell_size", 20), bool) and 5 <= arguments.get("min_cell_size", 20) <= 5000 else None
    if minimum is None:
        raise ValueError("min_cell_size must be an integer from 5 to 5000.")
    smooth = filters.gaussian(image.astype(float), sigma=1)
    binary = morphology.remove_small_objects(smooth > filters.threshold_otsu(smooth), min_size=minimum)
    binary = ndimage.binary_fill_holes(morphology.binary_closing(binary, morphology.disk(2)))
    distance = ndimage.distance_transform_edt(binary)
    markers = measure.label(morphology.local_maxima(distance))
    segmented = segmentation.watershed(-distance, markers, mask=binary)
    table = measure.regionprops_table(segmented, properties=("label", "area", "perimeter", "eccentricity"))
    rows = []
    for index in range(len(table["label"])):
        perimeter = max(table["perimeter"][index], 1e-9)
        rows.append({"label": int(table["label"][index]), "area": float(table["area"][index]),
                     "perimeter": round(float(perimeter), 4), "eccentricity": round(float(table["eccentricity"][index]), 6),
                     "circularity": round(4 * math.pi * table["area"][index] / perimeter ** 2, 6)})
    areas = [row["area"] for row in rows] or [0.0]
    return {"cell_count": len(rows), "avg_cell_area": round(float(np.mean(areas)), 4),
            "area_range": [round(float(np.min(areas)), 4), round(float(np.max(areas)), 4)],
            "avg_circularity": round(float(np.mean([r["circularity"] for r in rows] or [0])), 6),
            "cells": rows[:300],
            "method": "Otsu + distance-transform watershed with area/perimeter/eccentricity/circularity census (upstream transcription)",
            "limitations": ["Watershed over-segments elongated chains; circularity is unreliable on dividing cells."]}


def analyze_aortic_diameter_and_geometry(arguments, files):
    import cv2
    import numpy as np

    image = _decode_gray(files, "image_path", "image_path")
    blurred = cv2.GaussianBlur(image, (5, 5), 0)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(blurred)
    _t, binary = cv2.threshold(enhanced, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    kernel = np.ones((3, 3), np.uint8)
    binary = cv2.morphologyEx(cv2.morphologyEx(binary, cv2.MORPH_OPEN, kernel), cv2.MORPH_CLOSE, kernel)
    contours, _hierarchy = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        raise ValueError("No contours detected; adjust contrast or segmentation.")
    aorta = max(contours, key=cv2.contourArea)
    points = aorta.reshape(-1, 2)
    root = sorted(points, key=lambda p: p[1], reverse=True)[:20]
    root_diameter = float(np.max([p[0] for p in root]) - np.min([p[0] for p in root]))
    y_mid = (points[:, 1].min() + points[:, 1].max()) / 2
    ascending = points[np.abs(points[:, 1] - y_mid) < 10]
    ascending_diameter = float(ascending[:, 0].max() - ascending[:, 0].min()) if len(ascending) else None
    moments = cv2.moments(aorta)
    centroid = (moments["m10"] / moments["m00"], moments["m01"] / moments["m00"]) if moments["m00"] else None
    hull = cv2.convexHull(aorta).reshape(-1, 2)
    far = hull[np.argmax([np.hypot(px - hull[:, 0].mean(), py - hull[:, 1].mean()) for px, py in hull])]
    contour_length = float(cv2.arcLength(aorta, closed=True))
    max_distance = float(np.max([np.hypot(px - far[0], py - far[1]) for px, py in points])) if centroid else 1.0
    return {"contour_area_px2": float(cv2.contourArea(aorta)), "centroid": [round(float(v), 2) for v in centroid] if centroid else None,
            "aortic_root_diameter_px": root_diameter,
            "ascending_diameter_px": round(ascending_diameter, 4) if ascending_diameter is not None else None,
            "contour_perimeter_px": round(contour_length, 4), "tortuosity": round(contour_length / max(max_distance, 1e-9), 4),
            "method": "CLAHE + Otsu + largest-contour geometry (root/ascending widths, arc-length tortuosity) as upstream",
            "limitations": ["Diameters are pixel measurements; calibrate with the acquisition scale before mm claims.",
                            "The largest contour is assumed to be the aorta exactly as upstream; adjacent structures corrupt it."]}


def analyze_thrombus_histology(arguments, files):
    import numpy as np
    from skimage import color

    rgb = _decode_color(files, "image_path", "image_path")
    lab = color.rgb2lab(rgb)
    lightness, a, b = lab[..., 0], lab[..., 1], lab[..., 2]
    fresh = (lightness < 50) & (a > 15)
    lysis = (lightness < 50) & (a <= 15) & (b > 10)
    endothel = (lightness >= 50) & (lightness < 70) & (b > 15)
    fibro = (lightness >= 70) & (a > 5)
    total = fresh.sum() + lysis.sum() + endothel.sum() + fibro.sum()
    def share(mask):
        return round(float(mask.sum() / total * 100), 4) if total else 0.0
    return {"fresh_percent": share(fresh), "cellular_lysis_percent": share(lysis),
            "endothelialization_percent": share(endothel), "fibroblastic_percent": share(fibro),
            "classified_fraction_of_image": round(float(total / lab[..., 0].size), 6),
            "method": "LAB color-space masks for the four thrombus components (upstream thresholds)",
            "limitations": ["The Lab cutoffs are upstream heuristics; stain batch variation shifts all four percentages.",
                            "Unclassified pixels are excluded from the denominator exactly as upstream normalized on classified pixels."]}


def analyze_intracellular_calcium_with_rhod2(arguments, files):
    import numpy as np

    background = _decode_gray(files, "background_image_path", "background_image_path").astype(float)
    control = _decode_gray(files, "control_image_path", "control_image_path").astype(float)
    sample = _decode_gray(files, "sample_image_path", "sample_image_path").astype(float)
    kd = _number(arguments.get("kd_nm", 570.0), "kd_nm", positive=True, maximum=1e6)
    control_corrected = np.maximum(control - background, 0)
    sample_corrected = np.maximum(sample - background, 0)
    f = float(sample_corrected.mean())
    f_max = float(control_corrected.mean())
    f_min = 0.0
    if f_max == f:
        raise ValueError("Sample and control intensities are identical; calcium cannot be resolved.")
    calcium = None if f_max == f else kd * (f - f_min) / (f_max - f)
    return {"control_intensity": round(f_max, 4), "sample_intensity": round(f, 4),
            "background_mean": round(float(background.mean()), 4),
            "estimated_calcium_nm": round(calcium, 4) if calcium is not None else None,
            "kd_nm": kd,
            "sample_std_in_mask": round(float(sample_corrected.std()), 4),
            "method": "Background-subtracted Grynkiewicz ratio [Ca] = Kd*(F-Fmin)/(Fmax-F) with Fmin = 0 (upstream transcription)",
            "limitations": ["Fmin = 0 and Fmax = ionophore control are upstream assumptions; true Rmin/Rmax calibrations change the estimate.",
                            "Mean-pixel estimation ignores cellular heterogeneity and saturation."]}


def quantify_corneal_nerve_fibers(arguments, files):
    import numpy as np
    from skimage import color, filters, measure, morphology

    image = _decode_multichannel(files, "image_path", "image_path")
    gray = color.rgb2gray(image) if image.ndim == 3 and image.shape[-1] >= 3 else image.astype(float)
    threshold = filters.threshold_otsu(gray)
    mask = morphology.remove_small_objects(gray > threshold, min_size=50)
    mask = morphology.closing(mask, morphology.disk(2))
    labels = measure.label(mask)
    props = measure.regionprops(labels)
    lengths = [p.major_axis_length for p in props]
    return {"fiber_area_px": int(mask.sum()), "total_area_px": int(mask.size),
            "fiber_density_percent": round(float(mask.mean() * 100), 4),
            "fiber_count": labels.max(),
            "mean_fiber_length_px": round(float(np.mean(lengths)), 4) if lengths else None,
            "max_fiber_length_px": round(float(np.max(lengths)), 4) if lengths else None,
            "method": "Otsu threshold with area-filtered fiber census (upstream transcription)",
            "limitations": ["Density counts bright mask area; branching nerves count as one region.",
                            "Threshold sensitivity is high for faint subbasimal plexus staining."]}


def segment_and_quantify_cells_in_multiplexed_images(arguments, files):
    import numpy as np
    from scipy import ndimage
    from skimage import filters, measure, morphology, segmentation

    image = _decode_multichannel(files, "image_path", "image_path")
    if image.ndim != 3:
        raise ValueError("multiplexed quantification needs a multichannel (channels-first or -last) image.")
    markers = arguments.get("markers_list")
    if not isinstance(markers, list) or not 2 <= len(markers) <= 8 or any(not isinstance(m, str) for m in markers):
        raise ValueError("markers_list must contain 2 to 8 marker names.")
    nuclear_index = int(arguments.get("nuclear_channel_index", 0)) if isinstance(arguments.get("nuclear_channel_index", 0), int) and not isinstance(arguments.get("nuclear_channel_index", 0), bool) and 0 <= arguments.get("nuclear_channel_index", 0) < len(markers) else None
    if nuclear_index is None:
        raise ValueError("nuclear_channel_index is out of range.")
    channels = image if image.shape[0] == len(markers) else (image if image.shape[-1] == len(markers) else None)
    if channels is None:
        raise ValueError(f"Image channels {image.shape} do not match the {len(markers)} markers.")
    axes_last = image.shape[-1] == len(markers)
    nuclear = (channels[..., nuclear_index] if axes_last else channels[nuclear_index]).astype(float)
    nuclei_binary = morphology.remove_small_objects(nuclear > filters.threshold_otsu(nuclear), min_size=50)
    nuclei_binary = morphology.binary_closing(nuclei_binary, morphology.disk(2))
    labeled_nuclei = measure.label(nuclei_binary)
    cells = segmentation.watershed(-ndimage.distance_transform_edt(~nuclei_binary), labeled_nuclei,
                                   mask=morphology.binary_dilation(nuclei_binary, morphology.disk(10)))
    rows = []
    for region in measure.regionprops(cells)[:500]:
        entry = {"cell": region.label, "centroid_y": round(float(region.centroid[0]), 2),
                 "centroid_x": round(float(region.centroid[1]), 2), "area": region.area}
        for index, marker in enumerate(markers):
            plane = channels[..., index] if axes_last else channels[index]
            entry[marker] = round(float(plane[cells == region.label].mean()), 4) if (cells == region.label).any() else None
        rows.append(entry)
    return {"markers": markers, "nuclei_count": labeled_nuclei.max(), "cells": rows,
            "method": "Nuclear Otsu seeds expanded by distance-watershed within a 10-disk dilation; per-marker mean intensities per cell",
            "limitations": ["A fixed 10-pixel expansion approximates cytoplasm; true membrane markers need channel-specific expansion.",
                            "Per-cell marker means include background where the dilation exceeds the cell."]}


def analyze_bone_microct_morphometry(arguments, files):
    frames = _decode_frames(files, "frame_paths", minimum=2)
    import numpy as np
    from scipy import ndimage
    from skimage import filters

    volume = np.asarray(frames, dtype=float)
    supplied = arguments.get("threshold_value")
    threshold = _number(supplied, "threshold_value") if supplied is not None else float(filters.threshold_otsu(volume))
    binary = volume > threshold
    if not binary.any() or binary.all():
        raise ValueError("The threshold produced a degenerate segmentation; adjust threshold_value.")
    bmd = float(volume[binary].mean())
    bone_volume = int(binary.sum())
    total_volume = int(binary.size)
    distances = ndimage.distance_transform_edt(binary)
    tb_th = float(distances[binary].mean()) * 2
    inverse = ndimage.distance_transform_edt(~binary)
    tb_s = float(inverse[~binary].mean()) if (~binary).any() else 0.0
    return {"shape": list(volume.shape), "threshold": round(threshold, 6),
            "bone_mineral_density_proxy": round(bmd, 6),
            "bone_volume_voxels": bone_volume, "total_volume_voxels": total_volume,
            "bv_tv_ratio": round(bone_volume / total_volume, 6),
            "trabecular_thickness_voxels": round(tb_th, 6),
            "trabecular_separation_voxels": round(tb_s, 6),
            "trabecular_number_per_voxel": round((bone_volume / total_volume) / tb_th, 8) if tb_th > 0 else None,
            "method": "Thresholded 3D volume with distance-transform Tb.Th/Tb.S and the standard derived Tb.N (upstream transcription)",
            "limitations": ["BMD here is the mean grayscale of bone voxels, not hydroxyapatite-calibrated density.",
                            "Voxel-based Tb.N is BV/TV over Tb.Th as upstream; plate-model assumptions differ from direct counting."]}


def find_roi_from_image(arguments, files):
    import cv2
    import numpy as np

    image = _decode_gray(files, "image_path", "image_path")
    lower = int(arguments.get("lower_threshold", 100)) if isinstance(arguments.get("lower_threshold", 100), int) and 0 <= arguments.get("lower_threshold", 100) <= 255 else None
    upper = int(arguments.get("upper_threshold", 200)) if isinstance(arguments.get("upper_threshold", 200), int) and 0 <= arguments.get("upper_threshold", 200) <= 255 else None
    if lower is None or upper is None or lower > upper:
        raise ValueError("Thresholds must be integers in [0, 255] with lower <= upper.")
    mask = cv2.bitwise_not(cv2.inRange(image, lower, upper))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (50, 1))
    processed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=1)
    contours, _hierarchy = cv2.findContours(processed, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    minimum_area = int(arguments.get("min_contour_area", 100))
    rois = []
    for contour in contours:
        area = cv2.contourArea(contour)
        if area < minimum_area:
            continue
        x, y, w, h = cv2.boundingRect(cv2.convexHull(contour))
        if w * h > image.size * 0.5:
            continue
        region = image[y:y + h, x:x + w]
        if region.size == 0:
            continue
        std = float(np.std(region))
        edge = float(np.mean(np.abs(cv2.Laplacian(region, cv2.CV_64F))))
        gradient = float(np.mean(np.sqrt(cv2.Sobel(region, cv2.CV_64F, 1, 0, ksize=3) ** 2
                                         + cv2.Sobel(region, cv2.CV_64F, 0, 1, ksize=3) ** 2)))
        if std > 50.0 or edge > 10.0 or gradient > 70.0:
            continue  # Text-like regions: upstream's distribution filter.
        rois.append({"roi": [int(x), int(y), int(w), int(h)], "area_px2": int(area), "std_dev": round(std, 4)})
    return {"roi_count": len(rois), "rois": rois[:100],
            "method": "Inverted range mask + horizontal closing contours with the upstream edge/gradient/std text filter",
            "limitations": ["Band-like text can still pass the filter on clean scans; review ROIs before densitometry.",
                            "The 50x1 closing kernel assumes horizontal lane bands exactly as upstream."]}


def reconstruct_3d_face_from_mri_skip(*_args, **_kwargs):  # pragma: no cover - placeholder removed below
    raise NotImplementedError


def analyze_ciliary_beat_frequency(arguments, files):
    frames = _decode_frames(files, "frame_paths", minimum=16)
    fps = _number(arguments.get("fps", 100.0), "fps", positive=True, maximum=1e5)
    minimum = _number(arguments.get("min_freq_hz", 1.0), "min_freq_hz", minimum=0, maximum=1e4)
    maximum = _number(arguments.get("max_freq_hz", 40.0), "max_freq_hz", minimum=0, maximum=1e4)
    if minimum >= maximum:
        raise ValueError("min_freq_hz must be below max_freq_hz.")
    import numpy as np
    from numpy.fft import rfft

    height, width = frames[0].shape
    count = int(arguments.get("roi_count", 9)) if isinstance(arguments.get("roi_count", 9), int) and 1 <= arguments.get("roi_count", 9) <= 100 else None
    if count is None:
        raise ValueError("roi_count must be an integer from 1 to 100.")
    size = min(width, height) // 10
    rows = int(math.sqrt(count))
    columns = (count + rows - 1) // rows
    rois = []
    for i in range(rows):
        for j in range(columns):
            if len(rois) >= count:
                break
            x = max(0, min((j + 1) * width // (columns + 1) - size // 2, width - size))
            y = max(0, min((i + 1) * height // (rows + 1) - size // 2, height - size))
            rois.append((x, y, size, size))
    series = np.asarray([[float(frame[y:y + h, x:x + w].mean()) for frame in frames] for x, y, w, h in rois])
    frequencies = []
    for trace in series:
        centered = trace - trace.mean()
        windowed = centered * np.hanning(len(trace))
        magnitude = np.abs(rfft(windowed))
        axis = np.fft.rfftfreq(len(trace), d=1.0 / fps)
        valid = (axis >= minimum) & (axis <= maximum)
        if valid.any() and magnitude[valid].max() > 0:
            frequencies.append(float(axis[valid][np.argmax(magnitude[valid])]))
    return {"frames": len(frames), "fps": fps, "roi_count": len(rois), "roi_size_px": size,
            "valid_rois": len(frequencies),
            "median_beat_frequency_hz": round(float(np.median(frequencies)), 4) if frequencies else None,
            "frequencies_hz": [round(f, 4) for f in frequencies],
            "method": "Grid-ROI mean-intensity FFT with a Hanning window inside the caller's frequency band (upstream transcription)",
            "limitations": ["Video containers are replaced by frame sequences with an explicit fps; verify the sampling rate.",
                            "Dominant-FFT peaks can reflect motion artifacts or illumination flicker, not cilia."]}


def analyze_protein_colocalization(arguments, files):
    import numpy as np
    from skimage import exposure, filters
    from scipy import stats

    first = _decode_gray(files, "channel1_path", "channel1_path").astype(float)
    second = _decode_gray(files, "channel2_path", "channel2_path").astype(float)
    if first.shape != second.shape:
        raise ValueError("Both channels must share one image grid.")
    method = arguments.get("threshold_method", "otsu")
    if method not in ("otsu", "li", "yen"):
        raise ValueError("threshold_method must be otsu, li, or yen.")
    one = exposure.rescale_intensity(first, out_range=(0, 1))
    two = exposure.rescale_intensity(second, out_range=(0, 1))
    thresholds = {"otsu": filters.threshold_otsu, "li": filters.threshold_li, "yen": filters.threshold_yen}[method]
    mask1, mask2 = one > thresholds(one), two > thresholds(two)
    whole = stats.pearsonr(one.ravel(), two.ravel())
    pearson_whole = float(whole[0]) if math.isfinite(whole[0]) else 0.0
    combined = mask1 | mask2
    if combined.any():
        masked = stats.pearsonr(one[combined], two[combined])
        pearson_masked = float(masked[0]) if math.isfinite(masked[0]) else None
    else:
        pearson_masked = None
    denominator = math.sqrt(float((one ** 2).sum()) * float((two ** 2).sum()))
    moc = float((one * two).sum()) / denominator if denominator > 0 else None
    m1 = float((one * mask2).sum() / one.sum()) if one.sum() > 0 else None
    m2 = float((two * mask1).sum() / two.sum()) if two.sum() > 0 else None
    return {"pearson_whole_image": round(pearson_whole, 6),
            "pearson_above_threshold": round(pearson_masked, 6) if pearson_masked is not None else None,
            "manders_overlap_coefficient": round(moc, 6) if moc is not None else None,
            "manders_m1": round(m1, 6) if m1 is not None else None,
            "manders_m2": round(m2, 6) if m2 is not None else None,
            "thresholds": {"channel1": round(float(thresholds(one)), 6), "channel2": round(float(thresholds(two)), 6)},
            "method": f"Per-channel {method} thresholds with Pearson and Mander's coefficients (upstream transcription)",
            "limitations": ["Manders coefficients use hard thresholds; small threshold shifts move M1/M2 substantially.",
                            "Pearson assumes linear co-variation; bleed-through and saturation bias both metrics."]}


def quantify_amyloid_beta_plaques(arguments, files):
    import numpy as np
    from skimage import color, filters, measure, morphology
    from skimage.segmentation import clear_border

    image = _decode_multichannel(files, "image_path", "image_path")
    gray = color.rgb2gray(image) if image.ndim == 3 and image.shape[-1] >= 3 else image.astype(float)
    smoothed = filters.gaussian(gray, sigma=1)
    method = arguments.get("threshold_method", "otsu")
    if method not in ("otsu", "adaptive", "manual"):
        raise ValueError("threshold_method must be otsu, adaptive, or manual.")
    if method == "otsu":
        threshold = float(filters.threshold_otsu(smoothed))
        binary = smoothed > threshold
    elif method == "adaptive":
        block = 35 if min(smoothed.shape) > 35 else min(smoothed.shape) // 2 * 2 + 1
        binary = smoothed > filters.threshold_local(smoothed, block_size=block)
        threshold = None
    else:
        threshold = _number(arguments.get("manual_threshold", 0.5), "manual_threshold", minimum=0, maximum=1)
        binary = smoothed > threshold
    minimum_size = int(arguments.get("min_plaque_size", 30)) if isinstance(arguments.get("min_plaque_size", 30), int) and 5 <= arguments.get("min_plaque_size", 30) <= 100000 else None
    if minimum_size is None:
        raise ValueError("min_plaque_size must be an integer from 5 to 100000.")
    cleaned = morphology.remove_small_objects(binary, min_size=minimum_size)
    labels = clear_border(measure.label(cleaned))
    props = measure.regionprops(labels, intensity_image=gray)
    rows = [{"area": p.area, "perimeter": round(float(p.perimeter), 4), "eccentricity": round(float(p.eccentricity), 6),
             "mean_intensity": round(float(p.mean_intensity), 6)} for p in props[:400]]
    plaque_area = sum(row["area"] for row in rows)
    return {"plaque_count": labels.max(), "threshold": round(threshold, 6) if threshold is not None else None,
            "total_plaque_area_px": int(plaque_area), "area_fraction_percent": round(plaque_area / gray.size * 100, 6),
            "mean_plaque_area": round(float(np.mean([r["area"] for r in rows])), 4) if rows else None,
            "plaques": rows,
            "method": f"{method} thresholding with small-object removal, border clearing, and a plaque census (upstream transcription)",
            "limitations": ["Border plaques are discarded exactly as upstream; partial fields undercount.",
                            "Threshold choice dominates plaque counts; report the method with the counts."]}


_FRAME_FILE = {"extensions": [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"], "max_bytes": 64 * 1024 * 1024, "list": True, "max_files": 400}
_IMAGE_FILE = {"extensions": [".png", ".jpg", ".jpeg", ".tif", ".tiff", ".bmp"], "max_bytes": 64 * 1024 * 1024}


def _schema(properties, required):
    return {"type": "object", "properties": properties, "required": required, "additionalProperties": False}


def _tool(title, description, schema, example, path, function, dependency=("numpy", "scipy", "skimage"), file_inputs=None):
    entry = {"title": title, "description": description, "input_schema": schema, "example": example,
             "dependency": list(dependency), "implementation": "biomni-adapted",
             "upstream_functions": [{"path": path, "name": function}]}
    if file_inputs:
        entry["file_inputs"] = file_inputs
    return entry


_P = {"type": "string", "minLength": 1, "maxLength": 400}


TOOLS = {
    "analyze_cell_migration_metrics": _tool(
        "Cell migration metrics", "Track Otsu-detected cells across a frame sequence and report displacement, directionality, and speed per track.",
        _schema({"frame_paths": {"type": "array", "minItems": 2, "maxItems": 400, "items": _P},
                 "pixel_size_um": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e4, "default": 1.0},
                 "time_interval_min": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e4, "default": 5.0},
                 "min_track_length": {"type": "integer", "minimum": 2, "maximum": 100, "default": 5}}, ["frame_paths"]),
        {"frame_paths": ["build/compute-inputs/cell_f0.png", "build/compute-inputs/cell_f1.png", "build/compute-inputs/cell_f2.png",
                         "build/compute-inputs/cell_f3.png", "build/compute-inputs/cell_f4.png"]},
        "biomni/tool/bioengineering.py", "analyze_cell_migration_metrics", ("numpy", "scipy", "cv2"),
        {"frame_paths": _FRAME_FILE}),
    "analyze_calcium_imaging_data": _tool(
        "Calcium imaging activity", "Segment cells from a frame stack, extract dF/F traces, and quantify event rates, peaks, and SNR.",
        _schema({"frame_paths": {"type": "array", "minItems": 10, "maxItems": 400, "items": _P},
                 "acquisition_rate_hz": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e4, "default": 10.0}}, ["frame_paths"]),
        {"frame_paths": [f"build/compute-inputs/ca_f{i}.png" for i in range(12)]},
        "biomni/tool/bioengineering.py", "analyze_calcium_imaging_data", ("numpy", "scipy", "skimage"),
        {"frame_paths": _FRAME_FILE}),
    "analyze_myofiber_morphology": _tool(
        "Myofiber morphology", "Segment nuclei and myofibers from a two-channel image and report fiber size, perimeter, and eccentricity.",
        _schema({"image_path": _P, "nuclei_channel": {"type": "integer", "minimum": 0, "default": 0},
                 "myofiber_channel": {"type": "integer", "minimum": 0, "default": 1}}, ["image_path"]),
        {"image_path": "build/compute-inputs/myofiber.png"},
        "biomni/tool/bioengineering.py", "analyze_myofiber_morphology", ("numpy", "scipy", "skimage", "cv2"),
        {"image_path": _IMAGE_FILE}),
    "analyze_cell_morphology_and_cytoskeleton": _tool(
        "Cell morphology and cytoskeleton", "Quantify cell shape descriptors and Hough-line fiber orientation order from a fluorescence image.",
        _schema({"image_path": _P}, ["image_path"]),
        {"image_path": "build/compute-inputs/cells.png"},
        "biomni/tool/biophysics.py", "analyze_cell_morphology_and_cytoskeleton", ("numpy", "scipy", "skimage", "cv2"),
        {"image_path": _IMAGE_FILE}),
    "analyze_tissue_deformation_flow": _tool(
        "Tissue deformation flow", "Estimate grid optical flow between frames and report divergence, curl, and strain summaries.",
        _schema({"frame_paths": {"type": "array", "minItems": 2, "maxItems": 400, "items": _P},
                 "pixel_scale_um": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e4, "default": 1.0}}, ["frame_paths"]),
        {"frame_paths": ["build/compute-inputs/tissue_f0.png", "build/compute-inputs/tissue_f1.png"]},
        "biomni/tool/biophysics.py", "analyze_tissue_deformation_flow", ("numpy", "scipy", "cv2"),
        {"frame_paths": _FRAME_FILE}),
    "quantify_cell_cycle_phases_from_microscopy": _tool(
        "Microscopy cell-cycle phases", "Classify Otsu-segmented cells into G1/S/G2-M fractions with the upstream septum and size heuristics.",
        _schema({"image_paths": {"type": "array", "minItems": 1, "maxItems": 100, "items": _P}}, ["image_paths"]),
        {"image_paths": ["build/compute-inputs/cycle_a.png", "build/compute-inputs/cycle_b.png"]},
        "biomni/tool/cell_biology.py", "quantify_cell_cycle_phases_from_microscopy", ("numpy", "scipy", "skimage"),
        {"image_paths": {**_IMAGE_FILE, "list": True, "max_files": 100}}),
    "quantify_and_cluster_cell_motility": _tool(
        "Cell motility clustering", "Track centroids across frames and k-means cluster speed, directionality, and MSD motility features.",
        _schema({"frame_paths": {"type": "array", "minItems": 3, "maxItems": 400, "items": _P},
                 "num_clusters": {"type": "integer", "minimum": 2, "maximum": 6, "default": 3}}, ["frame_paths"]),
        {"frame_paths": [f"build/compute-inputs/motility_f{i}.png" for i in range(5)]},
        "biomni/tool/cell_biology.py", "quantify_and_cluster_cell_motility", ("numpy", "scipy", "cv2", "sklearn"),
        {"frame_paths": _FRAME_FILE}),
    "analyze_mitochondrial_morphology_and_potential": _tool(
        "Mitochondrial morphology and potential", "Skeletonize the morphology channel into branch/junction/fragmentation metrics and summarize potential-channel intensity.",
        _schema({"morphology_image_path": _P, "potential_image_path": _P}, ["morphology_image_path", "potential_image_path"]),
        {"morphology_image_path": "build/compute-inputs/mito.png", "potential_image_path": "build/compute-inputs/tmrm.png"},
        "biomni/tool/cell_biology.py", "analyze_mitochondrial_morphology_and_potential", ("numpy", "scipy", "skimage", "cv2"),
        {"morphology_image_path": _IMAGE_FILE, "potential_image_path": _IMAGE_FILE}),
    "track_immune_cells_under_flow": _tool(
        "Immune-cell flow tracking", "Track cells across frames and classify rolling, arrest, and crawling behavior against the flow direction.",
        _schema({"frame_paths": {"type": "array", "minItems": 5, "maxItems": 400, "items": _P},
                 "pixel_size_um": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e4, "default": 1.0},
                 "time_interval_sec": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e4, "default": 1.0},
                 "flow_direction": {"type": "string", "enum": ["right", "left", "up", "down"], "default": "right"}}, ["frame_paths"]),
        {"frame_paths": [f"build/compute-inputs/flow_f{i}.png" for i in range(6)]},
        "biomni/tool/immunology.py", "track_immune_cells_under_flow", ("numpy", "scipy", "cv2"),
        {"frame_paths": _FRAME_FILE}),
    "analyze_cns_lesion_histology": _tool(
        "CNS lesion histology", "Quantify infiltrating cells, myelin fraction, and GLCM texture from H&E, LFB, or IHC lesion images.",
        _schema({"image_path": _P, "stain_type": {"type": "string", "enum": ["H&E", "LFB", "IHC"], "default": "H&E"}}, ["image_path"]),
        {"image_path": "build/compute-inputs/lesion.png", "stain_type": "H&E"},
        "biomni/tool/immunology.py", "analyze_cns_lesion_histology", ("numpy", "scipy", "skimage"),
        {"image_path": _IMAGE_FILE}),
    "analyze_immunohistochemistry_image": _tool(
        "IHC expression quantification", "Segment stained tissue and report per-region intensities, IOD, and centroid spacing.",
        _schema({"image_path": _P}, ["image_path"]),
        {"image_path": "build/compute-inputs/ihc.png"},
        "biomni/tool/immunology.py", "analyze_immunohistochemistry_image", ("numpy", "scipy", "skimage"),
        {"image_path": _IMAGE_FILE}),
    "segment_and_analyze_microbial_cells": _tool(
        "Microbial cell segmentation", "Watershed-segment fluorescence microbes and report area, perimeter, eccentricity, and circularity.",
        _schema({"image_path": _P, "min_cell_size": {"type": "integer", "minimum": 5, "maximum": 5000, "default": 20}}, ["image_path"]),
        {"image_path": "build/compute-inputs/microbes.png"},
        "biomni/tool/microbiology.py", "segment_and_analyze_microbial_cells", ("numpy", "scipy", "skimage", "cv2"),
        {"image_path": _IMAGE_FILE}),
    "analyze_aortic_diameter_and_geometry": _tool(
        "Aortic geometry", "Measure the largest contour's root and ascending diameters, perimeter, and tortuosity from an aortic image.",
        _schema({"image_path": _P}, ["image_path"]),
        {"image_path": "build/compute-inputs/aorta.png"},
        "biomni/tool/pathology.py", "analyze_aortic_diameter_and_geometry", ("numpy", "scipy", "cv2"),
        {"image_path": _IMAGE_FILE}),
    "analyze_thrombus_histology": _tool(
        "Thrombus component fractions", "Classify H&E thrombus pixels into fresh, lysis, endothelialization, and fibroblastic LAB-color components.",
        _schema({"image_path": _P}, ["image_path"]),
        {"image_path": "build/compute-inputs/thrombus.png"},
        "biomni/tool/pathology.py", "analyze_thrombus_histology", ("numpy", "scipy", "skimage", "cv2"),
        {"image_path": _IMAGE_FILE}),
    "analyze_intracellular_calcium_with_rhod2": _tool(
        "Rhod-2 calcium estimation", "Estimate intracellular calcium from background/control/sample Rhod-2 images with the Grynkiewicz ratio.",
        _schema({"background_image_path": _P, "control_image_path": _P, "sample_image_path": _P,
                 "kd_nm": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e6, "default": 570}},
                ["background_image_path", "control_image_path", "sample_image_path"]),
        {"background_image_path": "build/compute-inputs/rhod_bg.png", "control_image_path": "build/compute-inputs/rhod_max.png",
         "sample_image_path": "build/compute-inputs/rhod_sample.png"},
        "biomni/tool/pathology.py", "analyze_intracellular_calcium_with_rhod2", ("numpy", "scipy", "cv2"),
        {"background_image_path": _IMAGE_FILE, "control_image_path": _IMAGE_FILE, "sample_image_path": _IMAGE_FILE}),
    "quantify_corneal_nerve_fibers": _tool(
        "Corneal nerve fiber density", "Threshold immunofluorescent nerve images and report fiber density, count, and lengths.",
        _schema({"image_path": _P, "marker_type": {"type": "string", "maxLength": 100, "default": "beta-III tubulin"}}, ["image_path"]),
        {"image_path": "build/compute-inputs/cornea.png"},
        "biomni/tool/pathology.py", "quantify_corneal_nerve_fibers", ("numpy", "scipy", "skimage", "cv2"),
        {"image_path": _IMAGE_FILE}),
    "segment_and_quantify_cells_in_multiplexed_images": _tool(
        "Multiplexed cell quantification", "Expand nuclear seeds into cells and quantify every marker's mean intensity per cell.",
        _schema({"image_path": _P,
                 "markers_list": {"type": "array", "minItems": 2, "maxItems": 8, "items": {"type": "string", "minLength": 1, "maxLength": 50}},
                 "nuclear_channel_index": {"type": "integer", "minimum": 0, "maximum": 7, "default": 0}}, ["image_path", "markers_list"]),
        {"image_path": "build/compute-inputs/multiplex.png", "markers_list": ["DAPI", "CD3", "CD8"], "nuclear_channel_index": 0},
        "biomni/tool/pathology.py", "segment_and_quantify_cells_in_multiplexed_images", ("numpy", "scipy", "skimage", "cv2"),
        {"image_path": _IMAGE_FILE}),
    "analyze_bone_microct_morphometry": _tool(
        "Bone micro-CT morphometry", "Compute BV/TV, Tb.Th, Tb.S, and Tb.N from a thresholded micro-CT slice stack.",
        _schema({"frame_paths": {"type": "array", "minItems": 2, "maxItems": 400, "items": _P},
                 "threshold_value": {"type": "number", "minimum": 0, "maximum": 1e6}}, ["frame_paths"]),
        {"frame_paths": [f"build/compute-inputs/bone_z{i}.png" for i in range(4)]},
        "biomni/tool/pathology.py", "analyze_bone_microct_morphometry", ("numpy", "scipy", "skimage", "cv2"),
        {"frame_paths": _FRAME_FILE}),
    "find_roi_from_image": _tool(
        "Gel band ROI detection", "Detect band ROIs on blots or gels with range masks, horizontal closing, and text-region filtering.",
        _schema({"image_path": _P, "lower_threshold": {"type": "integer", "minimum": 0, "maximum": 255, "default": 100},
                 "upper_threshold": {"type": "integer", "minimum": 0, "maximum": 255, "default": 200},
                 "min_contour_area": {"type": "integer", "minimum": 10, "maximum": 100000, "default": 100}}, ["image_path"]),
        {"image_path": "build/compute-inputs/gel.png"},
        "biomni/tool/pharmacology.py", "find_roi_from_image", ("numpy", "scipy", "cv2"),
        {"image_path": _IMAGE_FILE}),
    "analyze_ciliary_beat_frequency": _tool(
        "Ciliary beat frequency", "FFT grid-ROI intensity series from a high-speed frame sequence and report the median dominant frequency.",
        _schema({"frame_paths": {"type": "array", "minItems": 16, "maxItems": 400, "items": _P},
                 "fps": {"type": "number", "exclusiveMinimum": 0, "maximum": 1e5, "default": 100},
                 "roi_count": {"type": "integer", "minimum": 1, "maximum": 100, "default": 9},
                 "min_freq_hz": {"type": "number", "minimum": 0, "maximum": 1e4, "default": 1},
                 "max_freq_hz": {"type": "number", "minimum": 0, "maximum": 1e4, "default": 40}}, ["frame_paths"]),
        {"frame_paths": [f"build/compute-inputs/cilia_f{i}.png" for i in range(24)], "fps": 100},
        "biomni/tool/physiology.py", "analyze_ciliary_beat_frequency", ("numpy", "scipy"),
        {"frame_paths": _FRAME_FILE}),
    "analyze_protein_colocalization": _tool(
        "Protein colocalization", "Compute Pearson and Mander's colocalization coefficients between two fluorescence channels.",
        _schema({"channel1_path": _P, "channel2_path": _P,
                 "threshold_method": {"type": "string", "enum": ["otsu", "li", "yen"], "default": "otsu"}},
                ["channel1_path", "channel2_path"]),
        {"channel1_path": "build/compute-inputs/chan1.png", "channel2_path": "build/compute-inputs/chan2.png"},
        "biomni/tool/physiology.py", "analyze_protein_colocalization", ("numpy", "scipy", "skimage", "cv2"),
        {"channel1_path": _IMAGE_FILE, "channel2_path": _IMAGE_FILE}),
    "quantify_amyloid_beta_plaques": _tool(
        "Amyloid plaque quantification", "Detect plaques by thresholding and report counts, areas, and burden fraction with border clearing.",
        _schema({"image_path": _P, "threshold_method": {"type": "string", "enum": ["otsu", "adaptive", "manual"], "default": "otsu"},
                 "manual_threshold": {"type": "number", "minimum": 0, "maximum": 1, "default": 0.5},
                 "min_plaque_size": {"type": "integer", "minimum": 5, "maximum": 100000, "default": 30}}, ["image_path"]),
        {"image_path": "build/compute-inputs/amyloid.png", "threshold_method": "otsu"},
        "biomni/tool/physiology.py", "quantify_amyloid_beta_plaques", ("numpy", "scipy", "skimage", "cv2"),
        {"image_path": _IMAGE_FILE}),
}
# Remove the placeholder that only exists to keep the module importable during drafting.
del globals()["reconstruct_3d_face_from_mri_skip"]
HANDLERS = {name: globals()[name] for name in TOOLS}
