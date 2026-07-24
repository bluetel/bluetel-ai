"""Engine registry for delegation targets.

Each engine the worker can route to is described by an ``EngineSpec``.
Adding a new engine (e.g. Claude Code) is a single ``register_engine``
call plus a new ``options`` entry in the tool YAML files — no changes to
payload construction or output handling are required.

``supports_agent`` / ``supports_model`` describe whether the field is
forwarded to the worker for that engine. When a caller provides a value
the engine does not support, the value is dropped and a warning is
surfaced in the tool output instead of failing the task.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class EngineSpec:
    """Describes one delegation engine known to the worker."""

    name: str
    """Engine identifier used in tool parameters (e.g. ``kiro``)."""

    worker_engine: str
    """Value sent as the ``engine`` field of the worker task payload."""

    label: str
    """Human-readable name for summaries and warnings."""

    supports_agent: bool
    """Whether the worker honours an ``agent`` selection for this engine."""

    supports_model: bool
    """Whether a ``model`` selection is forwarded for this engine."""


KIRO = EngineSpec(
    name='kiro',
    worker_engine='kiro',
    label='AWS Kiro',
    supports_agent=True,
    supports_model=True,
)

COPILOT = EngineSpec(
    name='copilot',
    worker_engine='copilot',
    label='GitHub Copilot CLI',
    supports_agent=False,
    supports_model=False,
)

CLAUDE = EngineSpec(
    name='claude',
    worker_engine='claude',
    label='Claude Code',
    supports_agent=False,
    supports_model=False,
)

_REGISTRY: dict[str, EngineSpec] = {}


def register_engine(spec: EngineSpec) -> None:
    """Registers an engine spec under its name."""
    _REGISTRY[spec.name] = spec


def get_engine(name: str) -> EngineSpec:
    """Looks up an engine by name.

    Raises ``ValueError`` listing the known engines when the name is not
    registered, so misconfigured workflow nodes fail with a clear message.
    """
    spec = _REGISTRY.get(name)
    if spec is None:
        known = ', '.join(sorted(_REGISTRY))
        raise ValueError(f'Unknown engine "{name}". Registered engines: {known}')
    return spec


def engine_names() -> list[str]:
    """Returns the registered engine names, sorted."""
    return sorted(_REGISTRY)


register_engine(KIRO)
register_engine(COPILOT)
register_engine(CLAUDE)
