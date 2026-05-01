import { CruiseRoute } from "./routes/CruiseRoute";
import { LandingRoute } from "./routes/LandingRoute";

export function App() {
  const route = getRoute(window.location.pathname);

  if (route === "cruise") {
    return <CruiseRoute />;
  }

  return <LandingRoute />;
}

function getRoute(pathname: string) {
  const route = pathname.replace(/\/+$/, "") || "/";

  if (route === "/cruise") {
    return "cruise";
  }

  return "landing";
}
