// Text files bundled as strings by Vite ("file.txt?raw").
declare module "*?raw" {
  const text: string;
  export default text;
}
