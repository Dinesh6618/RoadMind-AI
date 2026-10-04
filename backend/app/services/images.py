"""Upload validation and safe storage of report images."""

from __future__ import annotations

import io
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError

from ..config import UploadConfig


class ImageError(ValueError):
    """The upload is not an acceptable image. `status_code` maps to the HTTP response."""

    def __init__(self, message: str, status_code: int = 400):
        super().__init__(message)
        self.status_code = status_code


def decode_upload(data: bytes, cfg: UploadConfig) -> np.ndarray:
    """Validate an uploaded image and return it as an upright BGR array.

    Checks size, real image content (not just the file extension), format, minimum
    dimensions and decompression-bomb limits. EXIF metadata (which can carry the
    uploader's GPS position and device details) is discarded.
    """
    if not data:
        raise ImageError("The uploaded file is empty.")
    if len(data) > cfg.max_bytes:
        raise ImageError(f"Image is too large (limit {cfg.max_bytes // (1024 * 1024)} MB).", 413)

    Image.MAX_IMAGE_PIXELS = cfg.max_pixels
    try:
        probe = Image.open(io.BytesIO(data))
        fmt = probe.format
        probe.verify()
        im = Image.open(io.BytesIO(data))
        im.load()
    except Image.DecompressionBombError:
        raise ImageError("Image dimensions are too large.", 413) from None
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        raise ImageError("The file is not a valid image. Upload a JPEG, PNG or WebP photo.", 415) from None

    if fmt not in cfg.allowed_formats:
        raise ImageError(f"Unsupported image format {fmt}. Allowed: {', '.join(cfg.allowed_formats)}.", 415)

    im = ImageOps.exif_transpose(im).convert("RGB")
    if min(im.size) < cfg.min_side_px:
        raise ImageError(f"Image is too small (minimum {cfg.min_side_px}px on the short side).")

    longest = max(im.size)
    if longest > cfg.stored_max_side_px:
        scale = cfg.stored_max_side_px / longest
        im = im.resize((round(im.width * scale), round(im.height * scale)), Image.LANCZOS)
    return np.asarray(im)[:, :, ::-1].copy()


def save_jpeg(image_bgr: np.ndarray, path: Path, quality: int = 88) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(".jpg", image_bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise ImageError("Could not encode the image.", 500)
    path.write_bytes(buf.tobytes())
