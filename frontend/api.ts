export async function readResponse<T>(response: Response): Promise<T> {
  const data: unknown = await response.json();
  if (!response.ok) {
    const error =
      data && typeof data === 'object' && 'error' in data
        ? String(data.error)
        : '请求失败';
    throw Error(error);
  }
  return data as T;
}
