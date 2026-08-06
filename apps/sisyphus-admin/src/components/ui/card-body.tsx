import { cn } from '@sisyphus-admin/lib/cn'
import type { HTMLAttributes } from 'react'

/** The card's content well: card padding, body type. */
export const CardBody = ({ className, ...rest }: HTMLAttributes<HTMLDivElement>) => (
  <div {...rest} className={cn('type-body p-default', className)} />
)
