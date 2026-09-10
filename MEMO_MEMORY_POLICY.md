# Memo Memory Policy

## Scope

Memo memory is advisory context, never executable authority. Memory is scoped to
one of `global`, `project`, or `conversation`; project and conversation memory
must not be retrieved outside their owning project.

## Record Contract

Every stored memory must include its scope, source, creation time, owner, and
status. Model-generated or externally retrieved memories begin as `unverified`.
Only a user or a deterministic project check can promote a record to `verified`.

## User Control

Users can inspect, edit, pin, disable, and delete every memory record. Deletion
removes the record from future retrieval. Pinned records remain subject to their
scope and do not override project instructions or permissions.

## Retrieval And Promotion

Retrieval is bounded by relevance and token budget. Deduplicate against existing
records before creating a new one. An unverified memory may inform a question or
research path, but must not alter prompts, routing, models, permissions, files,
commands, approval requirements, or promotion criteria.

## Retention

Memory records require an invalidation condition. Project facts are reviewed
when their source changes; conversation memories expire when their conversation
is deleted or archived unless the user explicitly promotes them.
