"""Convert RDD2022 (Pascal-VOC XML) into the YOLO format used by train_yolo.py.

    cd ai
    python -m roadmind_ai.detection.convert_rdd2022 --rdd-root D:/data/RDD2022 --out ../datasets/rdd2022_yolo

Expected layout of the downloaded dataset (one folder per country):

    RDD2022/<Country>/train/images/*.jpg
    RDD2022/<Country>/train/annotations/xmls/*.xml

The official test splits ship without annotations, so a validation split (15 %) is
carved out of the annotated training images, deterministically by file name.

NOTE: written against the public RDD2022 layout but not run against the real
dataset in the development environment - adjust `find_image` if your copy differs.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import xml.etree.ElementTree as ET
from pathlib import Path

from .types import DAMAGE_CLASSES, RDD_CLASS_MAP


def find_image(xml_path: Path) -> Path | None:
    stem = xml_path.stem
    root = xml_path.parents[2] if len(xml_path.parents) > 2 else xml_path.parent
    for ext in (".jpg", ".jpeg", ".png"):
        candidate = root / "images" / f"{stem}{ext}"
        if candidate.exists():
            return candidate
    hits = list(root.rglob(f"{stem}.jp*g")) or list(root.rglob(f"{stem}.png"))
    return hits[0] if hits else None


def parse_xml(path: Path) -> tuple[int, int, list[tuple[int, float, float, float, float]]]:
    tree = ET.parse(path).getroot()
    size = tree.find("size")
    w, h = int(float(size.findtext("width"))), int(float(size.findtext("height")))
    rows = []
    for obj in tree.findall("object"):
        code = (obj.findtext("name") or "").strip().upper()
        label = RDD_CLASS_MAP.get(code)
        if label is None:
            continue
        bb = obj.find("bndbox")
        x1, y1, x2, y2 = (float(bb.findtext(k)) for k in ("xmin", "ymin", "xmax", "ymax"))
        if x2 <= x1 or y2 <= y1:
            continue
        rows.append((DAMAGE_CLASSES.index(label), (x1 + x2) / 2 / w, (y1 + y2) / 2 / h, (x2 - x1) / w, (y2 - y1) / h))
    return w, h, rows


def is_val(name: str, fraction: float = 0.15) -> bool:
    return int(hashlib.md5(name.encode()).hexdigest(), 16) % 1000 < fraction * 1000


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--rdd-root", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("../datasets/rdd2022_yolo"))
    ap.add_argument("--countries", nargs="*", help="only these country folders (e.g. India Japan); default all")
    args = ap.parse_args()

    xmls = sorted(args.rdd_root.rglob("*.xml"))
    if args.countries:
        xmls = [x for x in xmls if any(c in x.parts for c in args.countries)]
    if not xmls:
        raise SystemExit(f"No XML annotations found under {args.rdd_root}")

    for split in ("train", "val"):
        (args.out / "images" / split).mkdir(parents=True, exist_ok=True)
        (args.out / "labels" / split).mkdir(parents=True, exist_ok=True)

    counts = {"train": 0, "val": 0, "skipped": 0}
    for xml_path in xmls:
        img = find_image(xml_path)
        if img is None:
            counts["skipped"] += 1
            continue
        _, _, rows = parse_xml(xml_path)
        # country prefix avoids name clashes between countries
        key = f"{xml_path.parents[3].name if len(xml_path.parents) > 3 else 'rdd'}_{xml_path.stem}"
        split = "val" if is_val(key) else "train"
        shutil.copy2(img, args.out / "images" / split / f"{key}{img.suffix.lower()}")
        (args.out / "labels" / split / f"{key}.txt").write_text(
            "\n".join(f"{c} {x:.6f} {y:.6f} {w:.6f} {h:.6f}" for c, x, y, w, h in rows), encoding="utf-8"
        )
        counts[split] += 1

    names = "\n".join(f"  {i}: {n}" for i, n in enumerate(DAMAGE_CLASSES))
    (args.out / "dataset.yaml").write_text(
        f"path: {args.out.resolve().as_posix()}\ntrain: images/train\nval: images/val\nnames:\n{names}\n", encoding="utf-8"
    )
    print(f"Converted {counts['train']} train / {counts['val']} val images ({counts['skipped']} skipped, no image found).")
    print(f"Dataset config: {args.out / 'dataset.yaml'}")


if __name__ == "__main__":
    main()
