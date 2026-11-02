import { BrowserRouter, Route, Routes } from 'react-router-dom';
import App from './App.js';
import DriverPortal from './DriverPortal.js';

/** Route table shared by the browser entry point and focused routing tests. */
export function DashboardRoutes() {
  return <Routes>
    <Route path="/" element={<App />} />
    <Route path="/driver" element={<DriverPortal />} />
    <Route path="/driver/*" element={<DriverPortal />} />
    <Route path="*" element={<App />} />
  </Routes>;
}

export default function DashboardRouter() {
  return <BrowserRouter><DashboardRoutes /></BrowserRouter>;
}
