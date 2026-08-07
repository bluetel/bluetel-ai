# `@bluetel-ai/sisyphus-api`

One tRPC definition, three consumption modes. See
[`specs/002-sisyphus-workflow-platform/contracts/api-surface.md`](../../specs/002-sisyphus-workflow-platform/contracts/api-surface.md).

## Why there is no root export

`package.json` declares four subpath exports and **no root `.` export**:

| Subpath       | Contains                                                                      | Safe in a browser bundle? |
| ------------- | ----------------------------------------------------------------------------- | ------------------------- |
| `./server`    | `appRouter`, resolvers, `createTRPCContext`, `createCaller`, Drizzle + driver | **No**                    |
| `./client`    | `AppRouter` **type**, `RouterInputs`/`RouterOutputs`, input schemas, enums    | Yes                       |
| `./contracts` | Connector interface, executor protocol types — types only                     | Yes                       |
| `./db`        | Schema and migrations, for migration tooling only                             | **No**                    |

A single root barrel would put the `postgres` driver, Drizzle and every resolver one import away
from a panel client component, and the executor's types-only guarantee would rest on nobody making
a mistake. FR-005's boundary has to be a build-time fact, not a review convention — so the root
barrel that would collapse the four subpaths into one simply does not exist, and `main`/`types` are
deliberately unset.

Each subpath is still a directory with its own `index.ts` barrel, so the barrel convention holds;
what is removed is only the root barrel.
