import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from "@nestjs/common";
import { AuthRequest, context } from "../../http.js";
import {
  createDirectorProject,
  createDirectorRender,
  deleteDirectorProject,
  directorScript,
  directorNativeAccess,
  listDirectorProjects,
  listDirectorRevisions,
  readDirectorRevision,
  patchDirectorProject,
  readDirectorProject,
  readDirectorRender,
  updateDirectorRender,
} from "./director.js";
import {
  analyzeDirectorReference,
  generateDirectorStoryboard,
  suggestDirectorShot,
} from "./director-model.js";

@Controller("api/v1/my-workspace/director/projects")
export class DirectorController {
  @Get() @Header("Cache-Control", "private, no-store") list(
    @Req() r: AuthRequest,
  ) {
    return listDirectorProjects(context(r));
  }
  @Post() create(@Req() r: AuthRequest, @Body() body: unknown) {
    return createDirectorProject(context(r), body);
  }
  @Get(":id") @Header("Cache-Control", "private, no-store") project(
    @Req() r: AuthRequest,
    @Param("id") id: string,
  ) {
    return readDirectorProject(context(r), id);
  }
  @Patch(":id") save(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return patchDirectorProject(context(r), id, body);
  }
  @Delete(":id") remove(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Query("revision") revision?: string,
  ) {
    return deleteDirectorProject(context(r), id, revision);
  }
  @Get(":id/revisions") @Header("Cache-Control", "private, no-store") revisions(
    @Req() r: AuthRequest,
    @Param("id") id: string,
  ) {
    return listDirectorRevisions(context(r), id);
  }
  @Get(":id/revisions/:revision")
  @Header("Cache-Control", "private, no-store")
  revision(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Param("revision") revision: string,
  ) {
    return readDirectorRevision(context(r), id, revision);
  }
  @Get(":id/native-access")
  @Header("Cache-Control", "private, no-store")
  access(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Query("deviceId") deviceId?: string,
    @Query("version") version?: string,
  ) {
    return directorNativeAccess(context(r), id, deviceId, version);
  }
  @Get(":id/script") @Header("Cache-Control", "private, no-store") script(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Query("revision") revision?: string,
  ) {
    return directorScript(context(r), id, revision);
  }
  @Post(":id/storyboard") generate(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return generateDirectorStoryboard(context(r), id, body);
  }
  @Post(":id/suggestions") suggest(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return suggestDirectorShot(context(r), id, body);
  }
  @Post(":id/reference") analyze(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return analyzeDirectorReference(context(r), id, body);
  }
  @Post(":id/renders") render(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return createDirectorRender(context(r), id, body);
  }
  @Get(":id/renders/:renderId")
  @Header("Cache-Control", "private, no-store")
  version(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Param("renderId") renderId: string,
  ) {
    return readDirectorRender(context(r), id, renderId);
  }
  @Patch(":id/renders/:renderId") receipt(
    @Req() r: AuthRequest,
    @Param("id") id: string,
    @Param("renderId") renderId: string,
    @Body() body: unknown,
  ) {
    return updateDirectorRender(context(r), id, renderId, body);
  }
}
