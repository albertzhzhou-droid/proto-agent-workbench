run_dir <- Sys.getenv("PROTO_AGENT_RUN_DIR")
payload <- list(
  ok = TRUE,
  note = "R runtime fixture executed.",
  workspace = Sys.getenv("PROTO_AGENT_WORKSPACE")
)
json <- paste0(
  "{\n",
  "  \"ok\": true,\n",
  "  \"note\": \"R runtime fixture executed.\"\n",
  "}\n"
)
writeLines(json, file.path(run_dir, "r_summary.json"))
print(payload)
