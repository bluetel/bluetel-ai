import { base, workspaceChecks, withTypeChecking } from '@bluetel-ai/eslint-config-base'

export default [...base, ...workspaceChecks, ...withTypeChecking(import.meta.dirname)]
