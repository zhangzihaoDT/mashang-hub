# mashang-hub Development Rules

## Non-negotiable Architecture Boundary

`mashang-hub` is a generic control plane. It must not become a registry of `mashang-service` business scripts.

- Keep business logic, dataset knowledge, capability discovery and execution inside `mashang-service` or the local Worker.
- Keep Hub code limited to generic Conversation, Turn, Task, Model, Worker, Event, Permission, Artifact, timeout and cancel concerns.
- Do not hardcode business script names, dataset filenames, vehicle/topic-specific rules, or internal `mashang-service` paths in Hub code.
- Do not let Hub read the local filesystem or dataset directly.
- Prefer changing `mashang-service` or Worker when a business capability changes and the generic Hub protocol remains stable.

The canonical explanation is in [`docs/architecture-boundaries.md`](docs/architecture-boundaries.md).

## Before Adding a Hub Feature

Check whether the feature is generic infrastructure or business-specific execution. If it is business-specific, do not add a Hub-side mapping as a shortcut. First consider whether it belongs in the Worker or `mashang-service`.
