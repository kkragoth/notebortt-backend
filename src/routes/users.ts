import { Router } from 'express'
import type { RequestHandler } from 'express'
import type { UserService } from '../services/user.service.js'

function buildUserProfile(user: { id: string; email: string; name: string; avatarUrl: string | null }) {
  return { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl }
}

export function createUserRouter(userService: UserService, authMiddleware: RequestHandler) {
  const router = Router()

  router.get('/me', authMiddleware, async (req, res) => {
    const userId = req.userId!

    const user = await userService.getUserById(userId)

    if (!user) {
      res.status(404).json({ error: 'User not found' })
      return
    }

    res.json(buildUserProfile(user))
  })

  return router
}
