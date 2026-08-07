interface DataReadoutProps {
  /** What is being reported. Uppercase mono is applied by the token, not by the caller. */
  label: string
  /** The machine's answer — a count, a timestamp, an id. */
  value: string
}

/**
 * A labelled machine readout: a `label-mono` caption above a `data-mono` value.
 *
 * The two-family split as a component. The caption is what a person called the thing and the value
 * is what the machine returned, so a reader can tell the two apart without reading either. Every
 * count, timestamp and id on the admin pages goes through this rather than being set inline, which
 * is what stops a column of numbers ending up in the prose face.
 */
export const DataReadout = ({ label, value }: DataReadoutProps) => (
  <div className="gap-hair flex flex-col">
    <span className="type-label-mono text-graphite">{label}</span>
    <span className="type-data-mono text-ink">{value}</span>
  </div>
)
