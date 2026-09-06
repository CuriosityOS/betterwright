# Directory context benchmark

Build both checkouts, then run with the same managed browser executable. On Linux, run as a nonroot user with the Chromium sandbox available.

```sh
BETTERWRIGHT_CHROMIUM_PATH=/path/to/betterchromium bun benchmarks/runtime-efficiency/directory-context.ts --baseline /path/to/baseline --candidate /path/to/candidate --output directory-results.json
```

The benchmark launches both browsers through BetterWright and its network guard. It compares a normal form, 36 controls sharing a large form, and 36 separate product cards. Each fixture runs five warmup groups and twenty recorded groups of five directory scans. Results include per-scan wall time, exact directory equality, all samples, fixture identity, browser identity, and hashes of both source and built runtime files. Source and runtime identities must stay unchanged throughout each measurement.

These measurements describe directory-scan wall time, not CPU consumption or whole-task agent performance. Run on an otherwise idle host; baseline executes before candidate. Temporary browser profiles are removed after close. The command prints JSON when `--output` is omitted.
