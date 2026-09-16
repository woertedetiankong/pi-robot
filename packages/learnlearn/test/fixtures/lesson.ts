/** Offline sample used to verify the structured lesson contract, not model quality. */
export const sampleLesson = {
  summary: "同一个缓存失效时，让一个请求重新取数据，其余请求等结果，能减少重复工作。",
  scope: "仅针对同一个键的并发重建；不同键、失败和超时仍需另外处理。",
  example: "100 人查同一商品价格，只派一个请求查数据库，其余人等这次结果。",
  diagram: "[100 人查同一价格]\n     |\n     v\n[1 个查库，其余等待]\n     |\n     v\n[成功后共享结果]",
};
