"use client";

import { createContext, useContext } from "react";

// Whether a list shows the code before each name ("13 · Cédula de ciudadanía"). The record forms always do (owner
// 2026-11-05, replacing OD-12's "Ver códigos DIAN" switch); a bare combobox outside a record form shows names only.

const ShowCodesContext = createContext(false);
export const ShowCodesProvider = ShowCodesContext.Provider;
/** Whether the codes before names are shown here: always inside a record form. */
export const useShowCodes = (): boolean => useContext(ShowCodesContext);
