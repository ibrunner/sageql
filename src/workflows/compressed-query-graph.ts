import { StateGraph, END, START } from "@langchain/langgraph";
import { Annotation } from "@langchain/langgraph";
import { BaseMessage } from "@langchain/core/messages";
import { generateQuery } from "../agents/query-builder.js";
import { createGraphQLExecutorTool } from "../tools/graphql-executor.js";
import { queryValidatorTool } from "../lib/graphql/query-validation-output-parser.js";
import { QueryValidationOutputParser } from "../lib/graphql/query-validation-output-parser.js";
import { VALIDATION_RETRY_PROMPT } from "../agents/prompts/retry-validation.js";
import { EXECUTION_RETRY_PROMPT } from "../agents/prompts/retry-execution.js";
import { formatValidationErrors } from "../lib/graphql/error-formatting.js";
import { logger } from "../lib/logger.js";
import { getMessageString } from "../lib/get-message-string.js";
import { Tool } from "@langchain/core/tools";
import { z } from "zod";
import { LookupRequest } from "../lib/graphql/schema-lookup/types.js";
import { schemaListLookup } from "../lib/graphql/schema-lookup/schema-lookup.js";

const MAX_RETRIES = 3;

// Schema lookup tool for use within the workflow
class SchemaLookupTool extends Tool {
  name = "schema_lookup";
  description =
    "Look up multiple schema items at once. Useful for gathering all necessary schema information before building a query.";
  schema = z
    .object({
      input: z.string().optional(),
    })
    .transform((val) => val.input);

  private schemaData: any;

  constructor(schema: any) {
    super();
    this.schemaData = schema;
    logger.debug("Schema Lookup Tool - Initialized with schema:", {
      hasSchema: !!schema,
      schemaType: typeof schema,
    });
  }

  protected async _call(input: string) {
    logger.debug("Schema Lookup Tool - Input:", input);

    try {
      const requests = JSON.parse(input) as LookupRequest[];
      if (!this.schemaData?.__schema) {
        throw new Error("Invalid schema: missing __schema property");
      }
      const result = schemaListLookup(this.schemaData, requests);
      logger.debug("Schema Lookup Tool - Result:", {
        requestCount: requests.length,
        typesFound: Object.keys(result.types).length,
        fieldsFound: Object.keys(result.fields).length,
        relatedTypes: Array.from(result.metadata.relatedTypes),
      });
      return JSON.stringify(result);
    } catch (error) {
      logger.error("Schema Lookup Tool - Error:", error);
      throw error;
    }
  }
}

// Define state schema with reducers
const CompressedQueryGraphStateAnnotation = Annotation.Root({
  messages: Annotation<(string | BaseMessage)[]>({
    reducer: (x, y) => [...(x || []), ...y],
  }),
  schema: Annotation<any>({
    reducer: (x, y) => y || x,
  }),
  currentQuery: Annotation<string>({
    reducer: (x, y) => y || x,
  }),
  validationErrors: Annotation<string[]>({
    reducer: (x, y) => y || x,
  }),
  executionResult: Annotation<any>({
    reducer: (x, y) => y || x,
  }),
  retryCount: Annotation<number>({
    reducer: (x, y) => (y ?? 0) + (x ?? 0),
  }),
  schemaContext: Annotation<any>({
    reducer: (x, y) => y || x,
  }),
});

export type CompressedQueryGraphState =
  typeof CompressedQueryGraphStateAnnotation.State;

/**
 * Creates a LangGraph for handling GraphQL query generation, validation, and execution
 * using a compressed schema and dynamic schema lookups
 */
export async function createCompressedQueryGraph(
  apiUrl: string,
  compressedSchema: any,
) {
  // Initialize tools
  const executor = createGraphQLExecutorTool(apiUrl);
  const validator = queryValidatorTool;
  const validationParser = new QueryValidationOutputParser();
  const schemaLookup = new SchemaLookupTool(compressedSchema);

  // Create the graph
  const workflow = new StateGraph(CompressedQueryGraphStateAnnotation);

  // Schema Context Generation Node
  const generateSchemaContextNode = async (
    state: CompressedQueryGraphState,
  ) => {
    logger.debug("\n=== Schema Context Generation Step ===");
    const userMessage = getMessageString(
      state.messages[state.messages.length - 1],
    );

    try {
      // Analyze the user's request to determine what schema information we need
      const schemaRequests: LookupRequest[] = [
        // Always get the Query type as a starting point
        { lookup: "type", id: "Query" },
        // Search for relevant types based on the user's request
        { lookup: "search", query: userMessage, limit: 5 },
      ];

      const schemaContext = await schemaLookup.call(
        JSON.stringify(schemaRequests),
      );
      const parsedContext = JSON.parse(schemaContext);
      logger.debug("Generated Schema Context:", {
        typesCount: Object.keys(parsedContext.types || {}).length,
        fieldsCount: Object.keys(parsedContext.fields || {}).length,
      });

      return {
        schemaContext: parsedContext,
      };
    } catch (error) {
      logger.error("Schema Context Generation Error:", error);
      return {
        validationErrors: [
          error instanceof Error
            ? error.message
            : "Failed to generate schema context",
        ],
      };
    }
  };

  // Query Generation Node
  const generateQueryNode = async (state: CompressedQueryGraphState) => {
    logger.debug("\n=== Query Generation Step ===");
    const result = await generateQuery(
      getMessageString(state.messages[state.messages.length - 1]),
      JSON.stringify(state.schema),
      state.schemaContext,
    );
    return {
      currentQuery: result.query,
      validationErrors: result.errors || [],
    };
  };

  // Query Validation Node
  const validateQueryNode = async (state: CompressedQueryGraphState) => {
    logger.debug("\n=== Query Validation Step ===");
    const result = await validator.call({
      query: state.currentQuery,
      schema: JSON.stringify(state.schema),
    });
    const validationResult = await validationParser.parse(result);

    return {
      validationErrors: validationResult.errors || [],
    };
  };

  // Query Execution Node
  const executeQueryNode = async (state: CompressedQueryGraphState) => {
    logger.debug("\n=== Query Execution Step ===");
    try {
      const result = await executor.call({
        query: state.currentQuery,
      });
      return {
        executionResult: JSON.parse(result),
      };
    } catch (error) {
      return {
        validationErrors: [
          error instanceof Error ? error.message : String(error),
        ],
      };
    }
  };

  // Validation Retry Node
  const handleValidationErrorNode = async (
    state: CompressedQueryGraphState,
  ) => {
    const { validationContext } = formatValidationErrors(
      state.validationErrors,
    );
    const formattedPrompt = await VALIDATION_RETRY_PROMPT.format({
      validationContext,
      failedQuery: state.currentQuery,
      schemaContext: JSON.stringify(state.schemaContext, null, 2),
    });

    return {
      messages: [...state.messages, getMessageString(formattedPrompt.content)],
      retryCount: 1,
    };
  };

  // Execution Retry Node
  const handleExecutionErrorNode = async (state: CompressedQueryGraphState) => {
    const formattedPrompt = await EXECUTION_RETRY_PROMPT.format({
      errorMessage: state.validationErrors[0],
      failedQuery: state.currentQuery,
      schemaContext: JSON.stringify(state.schemaContext, null, 2),
    });

    return {
      messages: [...state.messages, getMessageString(formattedPrompt.content)],
      retryCount: 1,
    };
  };

  // Build the graph with chained method calls
  const graph = workflow
    .addNode("generate_schema_context", generateSchemaContextNode)
    .addNode("generate_query", generateQueryNode)
    .addNode("validate_query", validateQueryNode)
    .addNode("execute_query", executeQueryNode)
    .addNode("handle_validation_error", handleValidationErrorNode)
    .addNode("handle_execution_error", handleExecutionErrorNode)
    .addEdge(START, "generate_schema_context")
    .addEdge("generate_schema_context", "generate_query")
    .addEdge("generate_query", "validate_query")
    .addConditionalEdges(
      "validate_query",
      (state: CompressedQueryGraphState) => {
        if (state.validationErrors.length > 0) {
          return state.retryCount < MAX_RETRIES
            ? "handle_validation_error"
            : END;
        }
        return "execute_query";
      },
      ["handle_validation_error", "execute_query", END],
    )
    .addConditionalEdges(
      "execute_query",
      (state: CompressedQueryGraphState) => {
        if (state.validationErrors.length > 0) {
          return state.retryCount < MAX_RETRIES
            ? "handle_execution_error"
            : END;
        }
        return END;
      },
      ["handle_execution_error", END],
    )
    .addEdge("handle_validation_error", "generate_schema_context")
    .addEdge("handle_execution_error", "generate_schema_context");

  return graph.compile();
}
