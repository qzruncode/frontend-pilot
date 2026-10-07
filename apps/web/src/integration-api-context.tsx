import { createContext, useContext } from "react";
import { createIntegrationApi } from "./api";
export const inspectionIntegrationApi = createIntegrationApi("/api/v1/inspections");
export const IntegrationApiContext = createContext(createIntegrationApi());
export function useIntegrationApi() { return useContext(IntegrationApiContext); }
