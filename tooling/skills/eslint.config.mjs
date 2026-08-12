import { base, workspaceChecks, withTypeChecking } from '@bluetel-ai/eslint-config-internal'

export default [...base, ...workspaceChecks, ...withTypeChecking(import.meta.dirname)]
