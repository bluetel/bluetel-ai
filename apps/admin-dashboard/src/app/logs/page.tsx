'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

import { LogDetail } from './log-detail'
import { LogList } from './log-list'

const LogsPageContent = () => {
  const searchParams = useSearchParams()
  const filename = searchParams.get('filename')

  return filename ? <LogDetail filename={filename} /> : <LogList />
}

export default function LogsPage() {
  return (
    <Suspense>
      <LogsPageContent />
    </Suspense>
  )
}
