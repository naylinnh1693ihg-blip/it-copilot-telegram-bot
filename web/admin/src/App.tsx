import { Navigate, Route, Routes } from "react-router-dom";
import { ApiError } from "./api";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Login } from "./pages/Login";
import { Knowledge } from "./pages/Knowledge";
import { Memory } from "./pages/Memory";
import { Settings } from "./pages/Settings";
import { Usage } from "./pages/Usage";
import { useSession } from "./session";

function RequireSession({ children }: { children: React.ReactNode }) {
  const session = useSession();
  if (session.isPending) return <p className="page-status">Checking your session…</p>;
  if (session.error instanceof ApiError && session.error.status === 401) return <Navigate to="/login" replace />;
  if (session.error) return <p className="page-status error">{session.error.message}</p>;
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireSession>
            <Layout />
          </RequireSession>
        }
      >
        <Route index element={<Dashboard />} />
        <Route path="knowledge" element={<Knowledge />} />
        <Route path="memory" element={<Memory />} />
        <Route path="usage" element={<Usage />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
