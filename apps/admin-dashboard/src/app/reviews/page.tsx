'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense } from 'react'

import { ReviewDetail } from './review-detail'
import { ReviewList } from './review-list'

const ReviewsPageContent = () => {
  const searchParams = useSearchParams()
  const id = searchParams.get('id')

  return id ? <ReviewDetail id={id} /> : <ReviewList />
}

export default function ReviewsPage() {
  return (
    <Suspense>
      <ReviewsPageContent />
    </Suspense>
  )
}
