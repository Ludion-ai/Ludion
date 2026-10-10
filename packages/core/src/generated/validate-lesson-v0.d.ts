export interface AjvError {
  instancePath: string;
  schemaPath: string;
  keyword: string;
  params: Record<string, unknown>;
  message?: string;
}

export interface ValidateFn {
  (data: unknown): boolean;
  errors?: AjvError[] | null;
}

export const validate: ValidateFn;
export default validate;
