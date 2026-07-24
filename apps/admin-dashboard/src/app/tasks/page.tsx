'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

import { TaskDetail } from './task-detail'
import { TaskList } from './task-list'

const TasksPageContent = () => {
  const searchParams = useSearchParams()
  const id = searchParams.get('id')

  return id ? <TaskDetail id={id} /> : <TaskList />
}

export default function TasksPage() {
  return (
    <Suspense>
      <TasksPageContent />
    </Suspense>
  )
}
