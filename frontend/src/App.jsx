import Dashboard from './components/Dashboard'
import { SocketProvider } from './components/SocketProvider'
import './index.css'

export default function App() {
  return (
    <SocketProvider>
      <Dashboard />
    </SocketProvider>
  )
}
