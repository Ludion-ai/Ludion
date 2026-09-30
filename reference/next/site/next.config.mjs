// Reference shop on Next.js. A fixed build ID keeps two builds of the same source comparable.
export default {
  generateBuildId: async () => "ludion-reference",
  async redirects() {
    return [{ source: "/old-home", destination: "/", permanent: true }];
  },
};
