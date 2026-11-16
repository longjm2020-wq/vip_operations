import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  Header,
} from "@nestjs/common";
import { AuthRequest, context } from "../../http.js";
import {
  listEmployees,
  employeeCatalog,
  saveEmployee,
  archiveEmployee,
  listEmployeeTasks,
  createEmployeeTask,
  readEmployeeTask,
  controlEmployeeTask,
} from "./assistant-employees.js";

@Controller("api/v1/my-workspace/assistant/employees")
export class AssistantEmployeeController {
  @Get()
  @Header("Cache-Control", "private, no-store")
  directory(@Req() request: AuthRequest) {
    return listEmployees(context(request));
  }
  @Get("catalog")
  @Header("Cache-Control", "private, no-store")
  catalog(@Req() request: AuthRequest) {
    return employeeCatalog(context(request));
  }
  @Post()
  save(@Req() request: AuthRequest, @Body() body: unknown) {
    return saveEmployee(context(request), body);
  }
  @Post(":id/archive")
  archive(
    @Req() request: AuthRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return archiveEmployee(context(request), id, body);
  }
  @Get("tasks")
  @Header("Cache-Control", "private, no-store")
  tasks(@Req() request: AuthRequest, @Query("employeeId") employeeId?: string) {
    return listEmployeeTasks(context(request), employeeId);
  }
  @Post("tasks")
  create(@Req() request: AuthRequest, @Body() body: unknown) {
    return createEmployeeTask(context(request), body);
  }
  @Get("tasks/:id")
  @Header("Cache-Control", "private, no-store")
  task(@Req() request: AuthRequest, @Param("id") id: string) {
    return readEmployeeTask(context(request), id);
  }
  @Post("tasks/:id/control")
  control(
    @Req() request: AuthRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return controlEmployeeTask(context(request), id, body);
  }
}
