# Vendored ts-rust files

These three files are copies. Do not edit them here. Change them in `cf-ts-rust` and copy them again.

| File | sha256 |
|---|---|
| `ts_rust.wasm` | `f29baaf6b225aca584ed6b3584b13500762969ef862e9db4b36683ec6c8e7a87` |
| `core.js` | `8c8bc09d7c1025116c92c9eac81727c52e8a39c36b216957d24371a966252989` |
| `core.d.ts` | `abb9856329014149124bb3b1a6badec3d335cbd54a46c18ae338466449b5b989` |

Source: [`gingerhendrix/cf-ts-rust`](https://github.com/gingerhendrix/cf-ts-rust) at commit `cd26794` (`src/ts_rust.wasm`, `src/core.js`, `src/core.d.ts`).

- `ts_rust.wasm` is the ts-rust `ts_wasm` crate from upstream commit `79d71780`, with the cf-ts-rust patch `patches/ts-rust-wasm-memory-wins.patch` and an 8 MiB shadow stack. The cf-ts-rust README tells you how to rebuild it.
- `core.js` is upstream `npm/wasm/core.js` with two cf-ts-rust patches. `runTsc` returns `memoryBytes`, and memory reads do not use `subarray`, which fails past 128 MiB on hosted Workers.

ts-rust is MIT licensed (T3 Tools Inc.). The module also holds TypeScript (Apache 2.0) and Go (BSD 3-Clause) code. The license files are in [`third_party/ts-rust/`](../../third_party/ts-rust/).

To update, copy the three files from a cf-ts-rust commit, update the table, and run `bun run test`.
