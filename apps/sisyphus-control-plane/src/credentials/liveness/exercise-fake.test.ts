import { describe, expect, it } from 'vitest'

import { createFakeCredentialExerciser } from './exercise-fake'

/**
 * The fake is test support, so the only thing worth asserting about it is that it does not lie —
 * a fake that quietly answered success where a suite asked for a refusal would turn every suite
 * built on it green for the wrong reason.
 */

describe('createFakeCredentialExerciser', () => {
  const request = (agentCredentialId: string) => ({
    agentCredentialId,
    credentialName: `credential-${agentCredentialId}`,
    secretId: `sisyphus/agent-credential/${agentCredentialId}`,
  })

  it('succeeds by default, because most credentials in most suites are healthy', async () => {
    const exerciser = createFakeCredentialExerciser()

    expect(await exerciser.exercise(request('a'))).toStrictEqual({ outcome: 'succeeded' })
  })

  it('records requests in order, not merely as a set', async () => {
    const exerciser = createFakeCredentialExerciser()

    await exerciser.exercise(request('b'))
    await exerciser.exercise(request('a'))

    expect(exerciser.exercised()).toStrictEqual(['b', 'a'])
  })

  it('answers per credential, so one suite can have a limited seat and a broken one', async () => {
    const exerciser = createFakeCredentialExerciser({
      answers: { limited: { outcome: 'refused', response: { status: 429 } } },
      otherwise: { outcome: 'refused', response: { status: 401 } },
    })

    expect(await exerciser.exercise(request('limited'))).toMatchObject({
      response: { status: 429 },
    })
    expect(await exerciser.exercise(request('other'))).toMatchObject({ response: { status: 401 } })
  })

  it('can be told to answer differently part-way through', async () => {
    const exerciser = createFakeCredentialExerciser()
    exerciser.answer('a', { outcome: 'refused', response: { status: 429 } })

    expect(await exerciser.exercise(request('a'))).toMatchObject({ outcome: 'refused' })
  })

  it('throws where a suite asked it to, which is a different thing from refusing', async () => {
    // The distinction the sweep turns on: a refusal is the provider answering and gets classified,
    // a throw is the platform failing and must not defame the credential.
    const boom = new Error('Secrets Manager refused')
    const exerciser = createFakeCredentialExerciser({ throwsFor: { a: boom } })

    await expect(exerciser.exercise(request('a'))).rejects.toBe(boom)
    // Still recorded: the attempt happened, and a suite asserting on what was reached needs it.
    expect(exerciser.exercised()).toStrictEqual(['a'])
  })

  it('passes the secret identifier and never anything else about the material', async () => {
    const exerciser = createFakeCredentialExerciser()
    await exerciser.exercise(request('a'))

    expect(Object.keys(exerciser.requests[0] ?? {}).sort()).toStrictEqual([
      'agentCredentialId',
      'credentialName',
      'secretId',
    ])
  })
})
