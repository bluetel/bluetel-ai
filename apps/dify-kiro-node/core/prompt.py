"""Prompt construction for delegated tasks.

Mirrors the section-based structure of the worker's own prompt builder
(`kiro-github-worker/src/lib/prompt-builder.ts`): clearly delimited
sections joined by blank lines. The worker wraps every caller prompt in
its own role preamble and closing reminder (ephemeral environment,
commit/push rules), so this module deliberately does NOT duplicate those
constraints — it only structures what the Dify workflow contributes:
the task itself, context handed over from previous workflow nodes, and
optional acceptance criteria.
"""


def join_sections(*sections: str) -> str:
    """Joins prompt sections with blank lines, skipping empty ones."""
    return '\n\n'.join(s for s in sections if s)


def build_task_prompt(
    prompt: str,
    context: str | None = None,
    acceptance_criteria: str | None = None,
) -> str:
    """Builds the task prompt sent to the worker.

    @param prompt - The main task instruction (required)
    @param context - Output from a previous workflow node (e.g. an earlier
        agent's findings) to hand over to the coding agent
    @param acceptance_criteria - Conditions the change must satisfy
    """
    task = prompt.strip()
    if not task:
        raise ValueError('prompt is required and must be a non-empty string')

    sections = [task]

    if context is not None and context.strip():
        sections.append(
            '\n'.join(
                [
                    '--- CONTEXT FROM PREVIOUS STEP ---',
                    context.strip(),
                    '--- END CONTEXT ---',
                ]
            )
        )

    if acceptance_criteria is not None and acceptance_criteria.strip():
        sections.append(
            '\n'.join(
                [
                    '--- ACCEPTANCE CRITERIA ---',
                    acceptance_criteria.strip(),
                    '--- END ACCEPTANCE CRITERIA ---',
                ]
            )
        )

    return join_sections(*sections)
