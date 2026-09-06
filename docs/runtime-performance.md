# Runtime performance

BetterWright reuses shared action-directory context and limits the GPU-less Linux software renderer to WebGL. The measurements below cover these specific workloads. They do not establish that every browser task is faster.

The retained measurements ran on 2026-09-05 with Linux x64, an AMD Ryzen 9 7950X3D, Bun 1.4.0, and the same pinned BetterChromium backend for baseline and candidate runs.

## Faster action-directory scans

Action-directory scans now reuse context text for controls that share the same root element. The cache exists only during one frame evaluation. It cannot carry page text across scans, frames, or navigation, and the returned directory is unchanged.

The large fixtures use 36 controls. Each fixture runs five warmup groups and twenty measured groups of five scans. On the large shared-form case, median scan wall time fell from 52.6 ms to 5.3 ms in forward order and from 54.1 ms to 4.8 ms in reverse order. That is a 90% to 91% reduction. Normal forms moved from 1.4 ms to 1.2 ms, while forms with distinct context roots moved from 2.4 ms to 2.6 ms. Those cases are effectively unchanged at this scale.

Run the committed [directory context benchmark](../benchmarks/runtime-efficiency/README.md) against two built checkouts to reproduce this comparison. Per-run measurements and scan samples are in the [measurement data](../benchmarks/runtime-efficiency/measurements-2026-09-05.json). The benchmark measures scan wall time, not browser CPU or whole-task performance.

## Lower CPU on GPU-less Linux

When Linux has no usable render device, BetterWright now scopes software rendering to WebGL with `--use-angle=swiftshader-webgl`. The native hardware path is unchanged. Chromium documents this mode as its [SwiftShader WebGL fallback](https://chromium.googlesource.com/chromium/src/+/main/docs/gpu/swiftshader.md).

Across 12 retained runs, whole measured-process CPU fell from a 13.435-second median to 3.035 seconds over browser startup, idle periods, DOM reads, a 640 by 360 rendering probe, and a 60 FPS recording probe. That is 77.4% lower for this measured lifecycle. GPU-process CPU fell from 11.220 seconds to 0.635 seconds.

The capability checks remained intact. WebGL 1 and WebGL 2 were available in every run, and both pixel-read probes returned the expected colors. The first 60 frames decoded from each of the 12 MP4 files were all unique, with changes between every adjacent frame.

Memory was roughly flat. Recording-phase aggregate RSS was 1391.9 MiB before and 1406.0 MiB after, about 1% higher. The existing renderer-process limit and recording resource bounds remain in place; this comparison measures no additional RAM savings.

The fallback requires the pinned BetterChromium release, which includes the Linux software-GPU renderer identity patch. CI keys its browser cache by release tag and asset checksum so an older revision of the same Chromium version cannot supply the test binary. For an older local managed installation, run `betterwright setup --force` to install the pinned artifact.

## Recording

The [recording API](recording.md), CLI, and MCP tool remain available with MP4 and WebM output. The browser regression checks that recording keeps the same page, state, and animation alive between calls. Canvas2D, WebGL 1/2 shader rendering, and screenshot pixels are checked alongside the runtime changes.

## Frame references in batched controls

`controls.batch` now accepts the frame-prefixed references that interactive snapshots already return, including nested-frame references and their `aria-ref=` form. The change keeps the existing length, target, password, write, and redaction checks.

The browser regression covers controls in the main document, a child frame, and a nested frame, with both plain references and the `aria-ref=` prefix. Malformed references remain rejected.
