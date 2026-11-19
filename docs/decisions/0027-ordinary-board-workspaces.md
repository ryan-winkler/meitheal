# ADR 0027: One Board model

Status: accepted; release qualification pending.

## Decision

A Board is a user-defined workspace and access boundary. Household is an editable example name. Work, House, Church and other names use the same commands and capabilities. Areas group work within a Board. Projects belong to their Board and can associate with an Area; an unfiled Project is valid. Names do not select features or authority.

Every Board uses the existing task engine, task kinds, Kanban, Table, Calendar, Timeline, planning and progress. Compatibility URLs resolve into that engine. Boards is the parent navigation collection; its authorized Boards are peers. Personal sidebar hiding does not change access.

Goals can associate with Boards, Areas and Projects. A shared Goal exposes only the receiving reader's accessible Project contributions. Private Project names, counts, progress and denominators remain private. Routines share the existing template and occurrence engine across optional Board/Area/Project placement. Personal Pillars remain private to their verified owner; Board Pillars use Board ownership and audience policy.

## Authority and storage

One verified Board scope carries the selected immutable Board ID, current actor, capabilities and access revision. Visibility, membership, send-only submission, task mutation, assignment, completion, deletion and lifecycle are separate permissions. A child or agent does not acquire completion/deletion through assignment or an administrator transport header. An explicit credential remains an independent ceiling when a genuine Home Assistant caller is also present.

Schema 26 retains existing work identities and historical null ownership behind a private storage adapter. `legacy_null_v1` and `scoped_v1` describe physical encoding only. They do not select product behavior. The real Area ID `default` remains real; an internal sentinel represents unfiled legacy storage without inventing a visible Area.

Queries compose explicit owned scopes before filtering, joins, totals or pagination. Writers validate current ownership, effective Project parent Area, placement, version and every mutation intent on their actual transaction. No arbitrary SQL rewriting or unscoped repository overload is permitted.

Authority transitions use the excluded grant journal. Exclusive local database creation is fresh-enrollment provenance. Existing empty or epochless files do not establish that provenance. Unknown or restored data remains closed until independently current operator custody is established. Schema validation remains exact for the admitted version, including triggers on restart.

## Connected work

Integration bindings identify a source, purpose, generation, allowed operations and Board with optional Area/Project destination. Configuration is independent of names. Current provider dispatch, retry and commit revalidate the original binding and actor. A missing or retired destination pauses work instead of silently moving it.

Global profile changes require system administration and management of every affected Board. The same journal writer changes the profile and invalidates affected generations. Native HA global entities/events and broad notification channels cannot publish private Board content. Current human actions and unattended configured automation are distinct authorities.

Durable common-command evidence permits a proved deletion or assignment event after the originating actor loses access to the live task. It grants no task read. Evidence is internal and checked again for current rights, placement, version and receiver binding. Public responses use explicit field projections.

The existing offline engine partitions work by verified actor, installation and Board. A switched actor or Board cannot inherit a queue. Work APIs and SSR pages are network-only in the service worker; the static offline fallback contains no work data.

## Consequences and verification

This supersedes the Household-versus-named capability distinction in ADR 0025 and earlier guidance. Historical records remain historical evidence.

Qualify the same journeys on a renamed example and a newly created Board, including rich task types, views, Areas/Projects, reader-specific Goals, Routines, Pillars, send-only assignment and child/agent restrictions. Source tests, browser checks, hosted CI, native Supervisor rehearsal, exact packaged images and installed Green acceptance are separate gates. See the Board guide and release/backup runbooks. No partial source result establishes deployment.
