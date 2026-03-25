import cors from 'cors'

const AllowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] as const
const AllowedHeaders = ['Content-Type', 'Authorization'] as const

export function createCorsMiddleware(origin: string) {
  return cors({
    origin,
    credentials: true,
    methods: [...AllowedMethods],
    allowedHeaders: [...AllowedHeaders],
  })
}
