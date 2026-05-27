#!/usr/bin/env python3
"""将图片中非蓝色区域识别为陆地，并转换为四叉树表示。

脚本会先把图片二值化为“陆地 / 海洋”掩码，再用四叉树压缩陆地区域。
默认规则是：如果像素的蓝色不是明显占优，就视为陆地。

依赖：
    pip install pillow

示例：
    python scripts/image_to_quadtree.py input.png -o output.json --max-depth 8 --pretty
"""

from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any
# typing 导入已内联使用，避免未使用导入

try:
    from PIL import Image  # pyright: ignore[reportMissingImports]
except ImportError as exc:  # pragma: no cover - runtime dependency guard
    raise SystemExit("需要安装 Pillow，请执行：pip install pillow") from exc


@dataclass
class QuadNode:
    x: int
    y: int
    width: int
    height: int
    leaf: bool
    land: bool
    land_ratio: float
    children: list[dict[str, object]] | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="将图片中的陆地区域转换为四叉树 JSON 表示。")
    parser.add_argument("input", type=Path, help="源图片路径")
    parser.add_argument(
        "-o",
        "--output",
        type=Path,
        default=None,
        help="输出 JSON 路径，默认生成 <input>.quadtree.json",
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=8,
        help="最大递归深度，达到后即使区域仍混合也停止细分",
    )
    parser.add_argument(
        "--min-size",
        type=int,
        default=1,
        help="允许继续细分的最小边长",
    )
    parser.add_argument(
        "--blue-ratio",
        type=float,
        default=1.1,
        help="蓝色需要比红绿通道大多少倍才视为海洋",
    )
    parser.add_argument(
        "--blue-margin",
        type=int,
        default=24,
        help="蓝色需要比红绿通道至少高出多少才视为海洋",
    )
    parser.add_argument(
        "--alpha-threshold",
        type=int,
        default=16,
        help="低于该透明度的像素会被视为海洋",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="美化输出生成的 JSON",
    )
    return parser.parse_args()


def load_image(image_path: Path) -> Image.Image:
    if not image_path.exists():
        raise FileNotFoundError(f"未找到输入图片：{image_path}")

    return Image.open(image_path).convert("RGBA")


def is_land_pixel(
    pixel: Any,
    blue_ratio: float,
    blue_margin: int,
    alpha_threshold: int,
) -> bool:
    # 将像素安全解析为 (r,g,b,a)
    if pixel is None:
        return False

    if isinstance(pixel, (int, float)):
        red = green = blue = int(pixel)
        alpha = 255
    else:
        try:
            red = int(pixel[0])
            green = int(pixel[1])
            blue = int(pixel[2])
            alpha = int(pixel[3]) if len(pixel) > 3 else 255
        except Exception:
            return False

    if alpha <= alpha_threshold:
        return False

    blue_is_dominant = (
        blue >= max(red, green) * blue_ratio and blue >= max(red, green) + blue_margin
    )
    return not blue_is_dominant


def build_land_prefix_sum(
    image: Image.Image,
    blue_ratio: float,
    blue_margin: int,
    alpha_threshold: int,
) -> list[int]:
    width, height = image.size
    prefix_width = width + 1
    prefix = [0] * ((width + 1) * (height + 1))
    # 使用 PixelAccess 逐像素读取，避免 ImagingCore 的类型不确定
    pix_access = image.load()
    assert pix_access is not None, "无法访问图像像素数据"

    for y in range(height):
        row_sum = 0
        prefix_row = (y + 1) * prefix_width
        prefix_prev_row = y * prefix_width

        for x in range(width):
            p: Any = pix_access[x, y]

            # 标准化为 (r,g,b,a) 四元组以传入 is_land_pixel
            if p is None:
                pixel = (0, 0, 0, 0)
            elif isinstance(p, (int, float)):
                v = int(p)
                pixel = (v, v, v, 255)
            elif isinstance(p, (tuple, list)):
                try:
                    r = int(p[0])
                except Exception:
                    r = 0
                try:
                    g = int(p[1])
                except Exception:
                    g = 0
                try:
                    b = int(p[2])
                except Exception:
                    b = 0
                try:
                    a = int(p[3])
                except Exception:
                    a = 255
                pixel = (r, g, b, a)
            else:
                pixel = (0, 0, 0, 0)

            row_sum += 1 if is_land_pixel(pixel, blue_ratio, blue_margin, alpha_threshold) else 0
            prefix[prefix_row + x + 1] = prefix[prefix_prev_row + x + 1] + row_sum

    return prefix


def land_count(prefix: list[int], width: int, x: int, y: int, region_width: int, region_height: int) -> int:
    prefix_width = width + 1
    x1 = x
    y1 = y
    x2 = x + region_width
    y2 = y + region_height

    return (
        prefix[y2 * prefix_width + x2]
        - prefix[y1 * prefix_width + x2]
        - prefix[y2 * prefix_width + x1]
        + prefix[y1 * prefix_width + x1]
    )


def split_region(x: int, y: int, width: int, height: int) -> list[tuple[int, int, int, int]]:
    half_width = width // 2
    half_height = height // 2

    left_width = half_width
    right_width = width - half_width
    top_height = half_height
    bottom_height = height - half_height

    regions: list[tuple[int, int, int, int]] = []

    if left_width > 0 and top_height > 0:
        regions.append((x, y, left_width, top_height))
    if right_width > 0 and top_height > 0:
        regions.append((x + left_width, y, right_width, top_height))
    if left_width > 0 and bottom_height > 0:
        regions.append((x, y + top_height, left_width, bottom_height))
    if right_width > 0 and bottom_height > 0:
        regions.append((x + left_width, y + top_height, right_width, bottom_height))

    return regions


def build_quadtree(
    prefix: list[int],
    image_width: int,
    x: int,
    y: int,
    width: int,
    height: int,
    depth: int,
    max_depth: int,
    min_size: int,
) -> QuadNode:
    area = width * height
    lands = land_count(prefix, image_width, x, y, width, height)
    land_ratio = lands / area if area else 0.0

    if lands == 0:
        return QuadNode(
            x=x,
            y=y,
            width=width,
            height=height,
            leaf=True,
            land=False,
            land_ratio=0.0,
        )

    if lands == area:
        return QuadNode(
            x=x,
            y=y,
            width=width,
            height=height,
            leaf=True,
            land=True,
            land_ratio=1.0,
        )

    can_split = depth < max_depth and width > min_size and height > min_size

    if not can_split:
        return QuadNode(
            x=x,
            y=y,
            width=width,
            height=height,
            leaf=True,
            land=land_ratio >= 0.5,
            land_ratio=land_ratio,
        )

    children = [
        asdict(
            build_quadtree(
                prefix,
                image_width,
                child_x,
                child_y,
                child_width,
                child_height,
                depth + 1,
                max_depth,
                min_size,
            )
        )
        for child_x, child_y, child_width, child_height in split_region(x, y, width, height)
    ]

    if not children:
        return QuadNode(
            x=x,
            y=y,
            width=width,
            height=height,
            leaf=True,
            land=land_ratio >= 0.5,
            land_ratio=land_ratio,
        )

    return QuadNode(
        x=x,
        y=y,
        width=width,
        height=height,
        leaf=False,
        land=land_ratio >= 0.5,
        land_ratio=land_ratio,
        children=children,
    )


def main() -> int:
    args = parse_args()
    image = load_image(args.input)
    width, height = image.size
    output_path = args.output or args.input.with_suffix("").with_suffix(".quadtree.json")

    prefix = build_land_prefix_sum(
        image=image,
        blue_ratio=max(args.blue_ratio, 1.0),
        blue_margin=max(args.blue_margin, 0),
        alpha_threshold=max(args.alpha_threshold, 0),
    )

    tree = build_quadtree(
        prefix=prefix,
        image_width=width,
        x=0,
        y=0,
        width=width,
        height=height,
        depth=0,
        max_depth=max(args.max_depth, 0),
        min_size=max(args.min_size, 1),
    )

    payload: dict[str, object] = {
        "source": str(args.input),
        "width": width,
        "height": height,
        "classification": {
            "type": "non-blue-as-land",
            "blueRatio": max(args.blue_ratio, 1.0),
            "blueMargin": max(args.blue_margin, 0),
            "alphaThreshold": max(args.alpha_threshold, 0),
        },
        "maxDepth": max(args.max_depth, 0),
        "minSize": max(args.min_size, 1),
        "tree": asdict(tree),
    }

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2 if args.pretty else None),
        encoding="utf-8",
    )

    print(f"陆地区域四叉树 JSON 已写入：{output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
