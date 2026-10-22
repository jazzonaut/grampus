# Grampus

Grampus runs a measured pipeline of coding agents on Orca and verifies the result itself.

## Language

**Task**:
One user request carried from spec to acceptance in its own worktree. It has one Orca Run and one
event log.

**Recipe**:
The stages a task runs and the agent, model and effort of each. Copied into the task when it is
created. (Earlier versions called this a model profile.)

**Stage**:
One kind of worker in the pipeline: spec, spec review, tests, build, review or repair. Each run of a
stage is an Orca task with one or more dispatches.

**Round**:
One build or repair attempt, followed by verification, review and a decision. Round 0 is the build.

**Driver**:
The process that runs one task's pipeline, in the task's own Orca terminal. The only writer to the
task's Run and event log.

**Command**:
A user decision (approve, revise, reply, continue, retry, accept, abandon) queued by the CLI, a chat
agent or the dashboard and applied by the driver.

**Guard**:
The deterministic integrity check of a round: clean tree, new commits, no rewritten history, protected
paths and tests intact.

**Comparison**:
One request run under several recipes from the same base commit, one task per recipe, scored side by
side. Full mode gives each recipe its own spec and cross-checks every result against every spec;
shared mode builds every recipe from one approved spec.

**Entry**:
One task of a comparison. The user keeps one entry (`pick`); the others finish as not selected.

**Estimated cost**:
A dispatch's tokens priced at API list prices (`modelPrices`). A yardstick for comparing recipes, not a
bill: subscription use is not charged per token.

## Example dialogue

User: Start a Grampus task in VectorZero to add CSV export.
Chat agent: Created the task. I will bring you the spec writer's questions and then the spec.
User: The spec looks right, approve it.
Chat agent: Approved version 2. I will tell you when it needs you again.
