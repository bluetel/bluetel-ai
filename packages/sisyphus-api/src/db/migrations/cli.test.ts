import { describe, expect, it } from 'vitest'

import { DATABASE_URL_VARIABLE, runMigrateCommand } from './cli'

describe('runMigrateCommand', () => {
  it('names the variable it needs rather than failing later with a connection error', async () => {
    await expect(runMigrateCommand({ env: {}, log: () => undefined })).rejects.toThrow(
      new RegExp(`${DATABASE_URL_VARIABLE} is not set`),
    )
  })

  it('treats a blank variable as unset, not as a valid empty connection string', async () => {
    await expect(
      runMigrateCommand({ env: { [DATABASE_URL_VARIABLE]: '   ' }, log: () => undefined }),
    ).rejects.toThrow(/is not set/)
  })

  it('never guesses a default database', async () => {
    await expect(
      runMigrateCommand({ env: { DATABASE_URL: 'postgres://x/y' }, log: () => undefined }),
    ).rejects.toThrow(/is not set/)
  })

  it('redacts the password before logging which database it is about to touch', async () => {
    const logged: string[] = []
    await runMigrateCommand({
      env: { [DATABASE_URL_VARIABLE]: 'postgres://user:hunter2@127.0.0.1:1/db' },
      log: (message) => logged.push(message),
    }).catch(() => undefined)

    expect(logged[0]).toBeDefined()
    expect(logged[0]).not.toContain('hunter2')
    expect(logged[0]).toContain('//***@127.0.0.1:1/db')
  })
})
