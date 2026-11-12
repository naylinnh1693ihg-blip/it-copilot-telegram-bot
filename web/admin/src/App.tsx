import { Navigate, Route, Routes } from "react-router-dom";
import { ApiError } from "./api";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { Login } from "./pages/Login";
import { Placeholder } from "./pages/Placeholder";
import { Settings } from "./pages/Settings";
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
        <Route path="knowledge" element={<Placeholder title="Knowledge" phase="the Knowledge Manager phase" />} />
        <Route path="memory" element={<Placeholder title="Memory" phase="the Memory Viewer phase" />} />
        <Route path="usage" element={<Placeholder title="Usage" phase="the Usage & Billing phase" />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
