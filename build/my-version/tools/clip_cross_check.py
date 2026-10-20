"""Compare the composite of a `.clip` with a reference PNG.

    python tools/clip_cross_check.py file.clip reference.png

The `.clip` is composited by an implementation that was written separately
from this one, and the result is compared with the reference PNG pixel by
pixel. A difference means the file and the application do not agree about
what the picture looks like.

Needs `clipparse` with its `image` extra: `pip install "clipparse[image]"`.
"""

import sys

import numpy as np
from PIL import Image

import clipparse


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    clip_path, reference_path = argv[1], argv[2]

    handle = clipparse.ClipFile()
    handle.load(clip_path)

    bgra = handle.merged_image()
    pixels = np.frombuffer(bgra, dtype=np.uint8).reshape(handle.height, handle.width, 4)
    composite = pixels[:, :, [2, 1, 0, 3]].astype(np.int16)

    reference = np.asarray(Image.open(reference_path).convert("RGBA")).astype(np.int16)

    print(f"composite {composite.shape}  reference {reference.shape}")
    if composite.shape != reference.shape:
        print("FAIL: the two images are not the same size")
        return 1

    difference = np.abs(composite - reference)
    worst = int(difference.max())
    print(f"max difference: {worst}")
    if worst == 0:
        print("=> the two composites are identical")
        return 0

    mask = difference.any(axis=2)
    ys, xs = np.nonzero(mask)
    print(f"differing pixels: {int(mask.sum())} of {mask.size} ({100.0 * mask.mean():.2f}%)")
    if len(ys):
        print(f"  bounding box: x {xs.min()}..{xs.max()}  y {ys.min()}..{ys.max()}")
        per_channel = difference[mask].max(axis=0)
        print(f"  worst per channel: R={per_channel[0]} G={per_channel[1]} B={per_channel[2]} A={per_channel[3]}")
    print("=> the composites differ")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
