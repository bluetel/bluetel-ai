import { describe, expect, it, vi } from 'vitest'

import {
  createForgeCredential,
  credentialDiagnostic,
  credentialQuery,
  CREDENTIAL_FILL_ENV,
  ForgeCredentialError,
  MAX_CREDENTIAL_DIAGNOSTIC_LENGTH,
  passwordFrom,
} from './forge-credential'
import type {
  CredentialFillCommand,
  CredentialFillResult,
  CredentialFiller,
} from './forge-credential'

/**
 * Reading the repository-host credential (FR-075, FR-072).
 *
 * **Nothing here spawns git and nothing here opens a socket.** The filler is injected in every
 * test, which is the only reason this suite can assert what the fill was asked without a real
 * credential helper — a developer's machine has one, and a test that queried it would pass here
 * and mean nothing.
 *
 * The property most of these tests are really about is the negative one: the credential appears in
 * no message, no diagnostic and no thrown error, on any path.
 */

const CREDENTIAL = 'ghp-not-a-real-token-0123456789'

const answering = (
  result: Partial<CredentialFillResult>,
): CredentialFiller & { readonly calls: CredentialFillCommand[] } => {
  const calls: CredentialFillCommand[] = []
  const filler = async (command: CredentialFillCommand): Promise<CredentialFillResult> => {
    calls.push(command)

    return Promise.resolve({
      stdout: '',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      ...result,
    })
  }

  return Object.assign(filler, { calls })
}

const filled = (credential = CREDENTIAL): string =>
  `protocol=https\nhost=forge.example\nusername=x-access-token\npassword=${credential}\n`

describe('credentialQuery', () => {
  it('writes git’s request format, terminated by the blank line git waits for', () => {
    expect(credentialQuery({ protocol: 'https', host: 'forge.example' })).toBe(
      'protocol=https\nhost=forge.example\n\n',
    )
  })
})

describe('passwordFrom', () => {
  it('reads the password out of git’s key-value answer', () => {
    expect(passwordFrom(filled())).toBe(CREDENTIAL)
  })

  it('splits at the first equals, so a token containing one survives intact', () => {
    expect(passwordFrom('password=abc=def==\n')).toBe('abc=def==')
  })

  it('tolerates the carriage returns a helper on a foreign platform may emit', () => {
    expect(passwordFrom('username=x\r\npassword=secret-value\r\n')).toBe('secret-value')
  })

  it('answers undefined for an answer that names no password', () => {
    expect(passwordFrom('protocol=https\nhost=forge.example\nusername=x-access-token\n')).toBe(
      undefined,
    )
  })

  it('answers undefined for a password line with nothing after the equals', () => {
    expect(passwordFrom('username=x\npassword=\n')).toBe(undefined)
  })

  it('answers undefined for an empty answer', () => {
    expect(passwordFrom('')).toBe(undefined)
  })

  it('is not fooled by a key that merely ends in password', () => {
    expect(passwordFrom('oauth_password=nope\n')).toBe(undefined)
  })
})

describe('credentialDiagnostic', () => {
  it('drops a credential-shaped line whole rather than trusting redaction to catch it', () => {
    const diagnostic = credentialDiagnostic(
      `warning: helper misbehaved\npassword=${CREDENTIAL}\nfatal: no credential`,
    )

    expect(diagnostic).not.toContain(CREDENTIAL)
    expect(diagnostic).toContain('warning: helper misbehaved')
    expect(diagnostic).toContain('fatal: no credential')
  })

  it('drops the username line too, which names the account if not the secret', () => {
    expect(credentialDiagnostic('username=someone@acme.test\nfatal: nope')).toBe('fatal: nope')
  })

  it('bounds the excerpt, because a helper can be arbitrarily chatty', () => {
    const diagnostic = credentialDiagnostic('e'.repeat(5_000))

    expect(diagnostic.length).toBe(MAX_CREDENTIAL_DIAGNOSTIC_LENGTH + 1)
    expect(diagnostic.endsWith('…')).toBe(true)
  })

  it('collapses an empty stderr to an empty string rather than to punctuation', () => {
    expect(credentialDiagnostic('\n\n  \n')).toBe('')
  })
})

describe('createForgeCredential', () => {
  it('asks git credential fill about the repository’s host, with prompting disabled', async () => {
    const fill = answering({ stdout: filled() })
    const credential = createForgeCredential({
      repositoryUrl: 'https://forge.example/acme/web.git',
      fill,
    })

    await expect(credential.read()).resolves.toBe(CREDENTIAL)

    expect(fill.calls).toHaveLength(1)
    expect(fill.calls[0].args).toStrictEqual(['credential', 'fill'])
    expect(fill.calls[0].stdin).toBe('protocol=https\nhost=forge.example\n\n')
    // A fill that can block on a terminal prompt is a bootstrap that hangs.
    expect(fill.calls[0].env).toStrictEqual(CREDENTIAL_FILL_ENV)
    expect(CREDENTIAL_FILL_ENV.GIT_TERMINAL_PROMPT).toBe('0')
  })

  it('reads the host out of an scp-style remote, which a rewritten remote often is', async () => {
    const fill = answering({ stdout: filled() })

    await createForgeCredential({ repositoryUrl: 'git@forge.example:acme/web.git', fill }).read()

    expect(fill.calls[0].stdin).toBe('protocol=https\nhost=forge.example\n\n')
  })

  it('never sends the user information a clone url can carry to the credential helper', async () => {
    const fill = answering({ stdout: filled() })

    await createForgeCredential({
      repositoryUrl: 'https://x-access-token:s3cr3t@forge.example/acme/web',
      fill,
    }).read()

    expect(fill.calls[0].stdin).not.toContain('s3cr3t')
    expect(fill.calls[0].stdin).toBe('protocol=https\nhost=forge.example\n\n')
  })

  it('does not ask git anything until it is read — phase 5 has not run at assembly', () => {
    const fill = answering({ stdout: filled() })

    createForgeCredential({ repositoryUrl: 'https://forge.example/acme/web', fill })

    expect(fill.calls).toStrictEqual([])
  })

  it('resolves once and answers from memory afterwards', async () => {
    const fill = answering({ stdout: filled() })
    const credential = createForgeCredential({
      repositoryUrl: 'https://forge.example/acme/web',
      fill,
    })

    await expect(credential.read()).resolves.toBe(CREDENTIAL)
    await expect(credential.read()).resolves.toBe(CREDENTIAL)
    await expect(credential.read()).resolves.toBe(CREDENTIAL)

    expect(fill.calls).toHaveLength(1)
  })

  it('shares one fill between concurrent readers rather than racing two', async () => {
    const fill = answering({ stdout: filled() })
    const credential = createForgeCredential({
      repositoryUrl: 'https://forge.example/acme/web',
      fill,
    })

    await expect(Promise.all([credential.read(), credential.read()])).resolves.toStrictEqual([
      CREDENTIAL,
      CREDENTIAL,
    ])
    expect(fill.calls).toHaveLength(1)
  })

  it('asks again after a failure, so a momentary refusal does not poison the run', async () => {
    const fill = vi
      .fn<CredentialFiller>()
      .mockResolvedValueOnce({ stdout: '', stderr: 'fatal: nope', exitCode: 1, timedOut: false })
      .mockResolvedValueOnce({ stdout: filled(), stderr: '', exitCode: 0, timedOut: false })

    const credential = createForgeCredential({
      repositoryUrl: 'https://forge.example/acme/web',
      fill,
    })

    await expect(credential.read()).rejects.toThrow(ForgeCredentialError)
    await expect(credential.read()).resolves.toBe(CREDENTIAL)
    expect(fill).toHaveBeenCalledTimes(2)
  })

  describe('every way there is no credential', () => {
    it('fails naming git itself when the binary could not be run', async () => {
      const fill = (): Promise<CredentialFillResult> =>
        Promise.reject(Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }))

      const failure = await createForgeCredential({
        repositoryUrl: 'https://forge.example/acme/web',
        fill,
      })
        .read()
        .catch((thrown: unknown) => thrown)

      expect(failure).toBeInstanceOf(ForgeCredentialError)
      expect((failure as ForgeCredentialError).kind).toBe('unavailable')
      expect((failure as Error).message).toContain('git could not be run on this instance')
      expect((failure as Error).message).toContain('ENOENT')
      expect((failure as Error).message).toContain('No pull request was opened')
    })

    it('fails naming the absent helper when git exited non-zero', async () => {
      const failure = await createForgeCredential({
        repositoryUrl: 'https://forge.example/acme/web',
        fill: answering({
          exitCode: 128,
          stderr:
            "fatal: could not read Username for 'https://forge.example': terminal prompts disabled",
        }),
      })
        .read()
        .catch((thrown: unknown) => thrown)

      expect((failure as ForgeCredentialError).kind).toBe('refused')
      expect((failure as Error).message).toContain('no git credential helper answered')
      expect((failure as Error).message).toContain('forge.example')
      expect((failure as Error).message).toContain('128')
      expect((failure as Error).message).toContain('terminal prompts disabled')
      expect((failure as Error).message).toContain('FR-075')
    })

    it('fails naming the missing password when git exited 0 and answered nothing useful', async () => {
      const failure = await createForgeCredential({
        repositoryUrl: 'https://forge.example/acme/web',
        fill: answering({ stdout: 'protocol=https\nhost=forge.example\nusername=x\n' }),
      })
        .read()
        .catch((thrown: unknown) => thrown)

      expect((failure as ForgeCredentialError).kind).toBe('empty')
      expect((failure as Error).message).toContain('named no password')
      // The whole point of failing here: a 401 several steps later names the wrong cause.
      expect((failure as Error).message).toContain('unauthorised')
    })

    it('treats an empty password line as no credential rather than as the empty string', async () => {
      await expect(
        createForgeCredential({
          repositoryUrl: 'https://forge.example/acme/web',
          fill: answering({ stdout: 'password=\n' }),
        }).read(),
      ).rejects.toThrow(/named no password/u)
    })

    it('fails naming the timeout when the helper blocked', async () => {
      const failure = await createForgeCredential({
        repositoryUrl: 'https://forge.example/acme/web',
        fill: answering({ timedOut: true, exitCode: null }),
        timeoutMs: 250,
      })
        .read()
        .catch((thrown: unknown) => thrown)

      expect((failure as ForgeCredentialError).kind).toBe('timed_out')
      expect((failure as Error).message).toContain('250ms')
      expect((failure as Error).message).toContain('No pull request was opened')
    })

    it('fails at read rather than at construction when the reference names no host', async () => {
      const credential = createForgeCredential({ repositoryUrl: 'acme/web', fill: answering({}) })

      await expect(credential.read()).rejects.toThrow(/names no host/u)
    })

    it('puts no credential in any failure message, on any path', async () => {
      const paths: readonly Partial<CredentialFillResult>[] = [
        { exitCode: 1, stderr: `password=${CREDENTIAL}\nfatal: helper failed` },
        { exitCode: 0, stdout: `username=${CREDENTIAL}\n` },
        { timedOut: true, exitCode: null, stderr: `password=${CREDENTIAL}` },
      ]

      for (const path of paths) {
        const message = await createForgeCredential({
          repositoryUrl: 'https://forge.example/acme/web',
          fill: answering(path),
        })
          .read()
          .catch((thrown: unknown) => (thrown as Error).message)

        expect(message).not.toContain(CREDENTIAL)
      }
    })
  })
})
