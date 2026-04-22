import Dashboard from '../src/components/Dashboard'
import { SocketProvider } from '../src/components/SocketProvider'

export default function Page() {
  return (
    <SocketProvider>
      <Dashboard />
    </SocketProvider>
  )
}
