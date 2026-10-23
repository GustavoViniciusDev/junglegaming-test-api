import { parseEnvironment } from "./src/infrastructure/config/environment";
import { databaseConfig } from "./src/infrastructure/database/database.config";

export default databaseConfig(parseEnvironment(process.env));
