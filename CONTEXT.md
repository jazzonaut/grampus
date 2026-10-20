# Grampus

Grampus turns a request into an approved plan and carries out the work through
implementation, checks, independent review and verified local Git delivery.

## Language

**Model profile**:
A named set of provider, model and supported reasoning effort choices for the agent
roles in a task. Each role's assignment stays fixed throughout a run; repair may have
its own assignment.

**Comparison**:
A group of runs that carry out the same shared plan from the same starting point
using different model profiles.

**Run**:
One execution of a task under a particular model profile, including its repair
attempts and final outcome. A repair attempt is part of a run, rather than a new run.

## Example dialogue

User: Use the same plan to compare these two model profiles.
Controller: Each run includes its own implementation, reviews, checks and repairs.
User: Export the comparison and the full details of both runs.
