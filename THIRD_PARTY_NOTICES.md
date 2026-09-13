# Third-Party Notices

## NVIDIA SoL-Pi

The ObservationPack and Evidence-Preserving Reducer mechanisms in `shared/` are a
port of [NVIDIA SoL-Pi](https://github.com/NVlabs/SoL-Pi), adapted from Pi's
in-harness `context` / `tool_result` events to the Anthropic Messages wire payload.

- Upstream: https://github.com/NVlabs/SoL-Pi
- License: MIT
- Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES

No upstream source is vendored verbatim; the algorithms, constants, and receipt
schema are reproduced and adapted. See `shared/observation-pack.mjs` and
`shared/evidence-reducer.mjs`.
