# This directory is inert. CI lives at the repo root.

GitHub only reads `.github/` at the **top level of a repository**. This one is a
leftover from the vendored OpenSEO fork, where `apps/dashboard` _was_ the repo
root.

The four workflows that used to sit in `.github/workflows/` here — `ci.yml`,
`docker-image.yml`, `pr-preview.yml`, `sourcemaps.yml` — never ran once in the
whole rankloop 2.0 build. "CI green" meant "green when somebody ran it locally".
They now live at `<repo root>/.github/workflows/`, adapted for the monorepo
(two pnpm roots, root Docker build context, engine-build ordering).

**Do not add workflows here.** They will not run. Add them to the root
`.github/workflows/` with `defaults: run: working-directory: apps/dashboard`.

`CODEOWNERS` is likewise inert — it is upstream's, naming an upstream
maintainer, and is not read at this path. It is kept only as a record of the
fork point; a rankloop `CODEOWNERS` belongs at the repo root when there are
maintainer handles to put in it.
