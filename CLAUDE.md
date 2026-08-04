# gno-observer

Read-only static-HTML dashboard (no build step, no backend — see
`index.html`) showing GRC20 tokens and detected NFT collections across
gno.land testnet/betanet.

## Shared knowledge base

This project is one of a family of related gno.land projects developed in
separate sessions (siblings: `~/gno-nft-minter`, `~/gno-nft-marketplace`,
`~/gno-tools`). They share a common knowledge file at
`~/gno-land-dev-notes.md`.

- At the start of substantial work here, read `~/gno-land-dev-notes.md` for
  established gno.land conventions (registry patterns, RPC call shapes,
  NFT detection heuristics, etc.) before rediscovering them from scratch.
- When you learn something broadly applicable to gno.land dev in general —
  not specific to this project's own code — append it to the "Cross-project
  discovery log" section at the bottom of that file, so the sibling
  projects benefit too. Keep project-specific implementation details local
  to this repo instead.
