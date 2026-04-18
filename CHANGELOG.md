# morning-feed

## 1.0.0

### Major Changes

- b18770c: Created Shelly.

### Minor Changes

- Decouple digest pipeline commands for production scheduling: digest now only builds and stores daily artifacts, digest:send sends from existing artifacts without regeneration, and cleanup runs independently via digest:cleanup.

  Add robust job notifications with reusable templates: failures send stage-specific alerts (build/send/cleanup) including error reason, and end-to-end success alerts are sent only after both generation and send complete for the same date.

### Patch Changes

- 2a1e815: Improve Ollama summarization reliability by adding retry/backoff for transient aborts and network failures, and increase default timeout for slower local models.
